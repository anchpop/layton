"""Authenticated ephemeral encryption boundary; vLLM is localhost-only.

Wire encodings are fixed-order JSON arrays, UTF-8 without whitespace. Never
log envelopes, plaintext, tokens, or exception text at this boundary.
"""
import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
import re
import time

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

# Tests inject a local store; production must not silently disable replay defense.
try:
    import modal
except ImportError:
    _results = None
else:
    _results = modal.Dict.from_name("layton-ai-results", create_if_missing=True)

RESULT_TTL_SECONDS = 14 * 24 * 3600
KEY_LIFETIME = 3600
KEY_GRACE = 300
VERSION = 2
ENVELOPE_VERSION = 1
MODEL = os.environ["LAYTON_MODEL"]
# The Worker's bearer key. Checked before anything else, on every route.
API_KEY = os.environ["VLLM_API_KEY"]
VLLM = "http://127.0.0.1:8001"
MAX_PROMPT_CHARS = 400_000
MAX_GEN_TOKENS = 8192
MAX_MODEL_LEN = int(os.environ.get("LAYTON_MAX_MODEL_LEN", "131072"))
_signing_key = serialization.load_der_private_key(
    base64.b64decode(os.environ["LAYTON_AI_SIGNING_KEY_DER_B64"], validate=True), password=None
)
if not isinstance(_signing_key, ec.EllipticCurvePrivateKey) or not isinstance(_signing_key.curve, ec.SECP256R1):
    raise ValueError("AI signing key must be ECDSA P-256")


def encode(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode()


class KeyRing:
    def __init__(self):
        self.current = None
        self.previous = None
        self.rotate()

    def rotate(self):
        now = time.time()
        if self.previous and now >= self.previous["expiresAt"] + KEY_GRACE:
            self.previous = None
        if self.current is None or now >= self.current["expiresAt"]:
            self.previous = self.current if self.current and now < self.current["expiresAt"] + KEY_GRACE else None
            private = ec.generate_private_key(ec.SECP256R1())
            self.current = {"private": private, "version": VERSION, "keyId": os.urandom(16).hex(),
                "publicKey": b64(private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
                "expiresAt": int(now) + KEY_LIFETIME}

    def statement(self):
        self.rotate()
        public = {k: v for k, v in self.current.items() if k != "private"}
        signed = encode([VERSION, public["keyId"], public["publicKey"], public["expiresAt"]])
        r, s = utils.decode_dss_signature(_signing_key.sign(signed, ec.ECDSA(hashes.SHA256())))
        return {**public, "signature": b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}

    def find(self, key_id):
        self.rotate()
        return next((key for key in (self.current, self.previous) if key and key["keyId"] == key_id), None)


_keys = KeyRing()


@asynccontextmanager
async def lifespan(_app):
    async def rotate():
        while True:
            _keys.rotate()
            await asyncio.sleep(1)
    task = asyncio.create_task(rotate())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def private_response(request, call_next):
    if not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {API_KEY}"):
        response = JSONResponse({"error": "unauthorized"}, status_code=401)
        response.headers["Cache-Control"] = "no-store"
        return response
    try:
        response = await call_next(request)
    except Exception:
        # No exception repr: library errors can embed plaintext/token ids.
        response = JSONResponse({"error": "request failed"}, status_code=500)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/key")
async def key():
    return _keys.statement()


def derive_keys(key, epk: str, gen: str) -> tuple[bytes, bytes, bytes]:
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(epk, validate=True))
    shared = key["private"].exchange(ec.ECDH(), peer)
    transcript = [VERSION, key["keyId"], key["publicKey"], epk, gen]
    return tuple(HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
        info=encode(["layton-ai", *transcript, purpose])).derive(shared)
        for purpose in ("request", "stream", "result"))


def aad(gen, kind, seq):
    return encode([VERSION, gen, kind, seq])


def unseal(key: bytes, envelope: bytes, context: bytes) -> bytes:
    if len(envelope) < 29 or envelope[0] != ENVELOPE_VERSION:
        raise ValueError("bad envelope")
    return AESGCM(key).decrypt(envelope[1:13], envelope[13:], context)


def seal(key: bytes, plaintext: bytes, context: bytes) -> bytes:
    # Fresh per-generation keys seal only thousands of frames: random 96-bit
    # nonces stay far below collision bounds without mutable nonce counters.
    iv = os.urandom(12)
    return bytes([ENVELOPE_VERSION]) + iv + AESGCM(key).encrypt(iv, plaintext, context)


def frame(key, gen, kind, seq, value):
    return encode({"type": kind, "seq": seq, "data": b64(seal(key, encode(value), aad(gen, kind, seq)))}) + b"\n"


async def wait_for_vllm() -> bool:
    # Probe even after startup: a crashed engine must not look permanently ready.
    async with httpx.AsyncClient(timeout=2) as client:
        try:
            return (await client.get(f"{VLLM}/health")).status_code == 200
        except httpx.HTTPError:
            return False


def _loading_state():
    # The launcher writes ONLY structured, allowlisted startup progress, never
    # the raw vLLM log (engine failure dumps can contain prompt token IDs).
    try:
        with open("/tmp/layton-loading.json") as file:
            return json.load(file)
    except (OSError, ValueError):
        return None


@app.get("/health")
async def health():
    ready = await wait_for_vllm()
    return {"wrapper": True, "model": ready, "modelId": MODEL, "maxModelLen": MAX_MODEL_LEN,
        "loading": None if ready else _loading_state()}


@app.post("/complete")
async def complete(request: Request) -> Response:
    try:
        body = await request.json()
        gen_id = body["gen"]
        if body["version"] != VERSION or not re.fullmatch(r"[0-9a-f-]{36}", gen_id):
            raise ValueError()
        server_key = _keys.find(body["keyId"])
        if server_key is None:
            return JSONResponse({"error": "unknown_key"}, status_code=409)
        req_key, stream_key, _ = derive_keys(server_key, body["epk"], gen_id)
        # Don't retain an ECDH private key through a long-running generation.
        del server_key
    except Exception:
        return JSONResponse({"error": "bad envelope"}, status_code=400)

    def error(message):
        return Response(frame(stream_key, gen_id, "error", 0, {"error": message}), media_type="application/x-ndjson")

    try:
        opened = json.loads(unseal(req_key, base64.b64decode(body["req"], validate=True), aad(gen_id, "request", 0)))
        prompt = opened["prompt"]
        # No timestamp: a replay must name a key id from the last hour (older
        # ones are erased) and a generation id nobody has claimed (claims last
        # 14 days). Together those refuse it without trusting anyone's clock.
        if opened["gen"] != gen_id:
            raise ValueError()
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
            raise ValueError()
        max_tokens = opened["maxTokens"]
        if type(max_tokens) is not int:
            raise ValueError()
        max_tokens = max(16, min(MAX_GEN_TOKENS, max_tokens))
        res_key = base64.b64decode(opened["resultKey"], validate=True)
        if len(res_key) != 32:
            raise ValueError()
    except Exception:
        return error("bad request")
    if not await wait_for_vllm():
        # No claim yet, so the browser can wait for health and retry safely.
        return JSONResponse({"error": "model still loading"}, status_code=503)
    try:
        # Atomic across concurrent requests AND container restarts. A claim is
        # never released on failure: duplicate ciphertext must never infer twice.
        claimed = await asyncio.to_thread(_results.put, gen_id, {"t": time.time()}, skip_if_exists=True)
        if not claimed:
            return error("generation already used")
    except Exception:
        return error("generation unavailable")

    payload = {
        "model": MODEL,
        "prompt": prompt[-MAX_PROMPT_CHARS:],
        "max_tokens": max_tokens,
        # A base model will occasionally open with end-of-text; don't let it
        # end the completion before it has said anything.
        "min_tokens": 16,
        # However chars map to tokens, never overflow the context: vLLM drops
        # the oldest prompt tokens, keeping the recent story. 131072 window
        # minus the largest possible generation.
        "truncate_prompt_tokens": MAX_MODEL_LEN - MAX_GEN_TOKENS - 64,
        "temperature": 0.85,
        # Trim the junk tail of the distribution — one garbage token ("viscous
        # oo…") is all it takes to derail prose into a references section.
        "min_p": 0.05,
        # Mild enough to leave names and dialogue tics alone, firm enough to
        # break verbatim loops before they lock in.
        "repetition_penalty": 1.05,
        # A paragraph break may flow through; a wider gap means the model is
        # done with this passage.
        "stop": ["\n\n\n"],
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    queue: asyncio.Queue = asyncio.Queue()

    async def run_generation():
        finish = None
        usage = {}
        parts = []
        seq = 0
        saw_done = False
        try:
            async with httpx.AsyncClient(timeout=900) as client:
                async with client.stream("POST", f"{VLLM}/v1/completions", json=payload) as response:
                    if response.status_code != 200:
                        raise ValueError()
                    async for raw in response.aiter_lines():
                        if not raw.startswith("data: "):
                            continue
                        data = raw[6:].strip()
                        if data == "[DONE]":
                            saw_done = True
                            break
                        obj = json.loads(data)
                        if obj.get("usage"):
                            usage = obj["usage"]
                        choices = obj.get("choices") or []
                        if choices:
                            finish = choices[0].get("finish_reason") or finish
                            delta = choices[0].get("text")
                            if delta:
                                parts.append(delta)
                                await queue.put(frame(stream_key, gen_id, "delta", seq, {"t": delta}))
                                seq += 1
            if not saw_done or finish is None:
                raise ValueError()
            text = "".join(parts)
            done = {"done": True, "count": seq, "hash": b64(hashlib.sha256(text.encode()).digest()),
                "finishReason": finish, "promptTokens": usage.get("prompt_tokens"), "completionTokens": usage.get("completion_tokens")}
            stored = b64(seal(res_key, encode({"text": text, **done}), aad(gen_id, "result", 0)))
            await asyncio.to_thread(_results.put, gen_id, {"t": time.time(), "res": stored})
            await queue.put(frame(stream_key, gen_id, "final", seq, done))
        except Exception:
            await queue.put(frame(stream_key, gen_id, "error", seq, {"error": "generation failed"}))
        finally:
            await queue.put(None)

    task = asyncio.create_task(run_generation())
    _active[gen_id] = task
    task.add_done_callback(lambda _t: _active.pop(gen_id, None))

    async def relay():
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item

    return StreamingResponse(relay(), media_type="application/x-ndjson")


_active: dict[str, asyncio.Task] = {}


@app.get("/result/{gen_id}")
async def result(gen_id: str):
    try:
        entry = await asyncio.to_thread(_results.get, gen_id)
    except Exception:
        return JSONResponse({"error": "result unavailable"}, status_code=503)
    # Read-time TTL is authoritative; the CPU sweeper is only physical cleanup.
    if entry and time.time() - entry.get("t", 0) >= RESULT_TTL_SECONDS:
        await asyncio.to_thread(_results.pop, gen_id, None)
        entry = None
    if entry and "res" in entry:
        return {"status": "ready", "res": entry["res"]}
    return {"status": "pending" if gen_id in _active else "gone"}
