"""Decrypting front door for the vLLM server.

The browser seals its prompt to this machine's public key, so everything in
between — Cloudflare included — relays ciphertext it cannot open. This wrapper
is the only listener on the public port; vLLM itself binds to localhost.

Per request: the client sends an ephemeral P-256 public key plus a sealed
envelope. ECDH against our static private key, then HKDF-SHA256 with two info
labels, yields one AES-256-GCM key for the request and another for the
response. The envelope format matches the client's crypto.ts exactly:
[version=1][IV 12B][ciphertext+tag].
"""

import asyncio
import base64
import json
import os
import re
import time

import httpx

# The container runs inside Modal, so the client library and credentials are
# already present; the Dict is where finished continuations wait (sealed) for
# a browser that closed its tab before the stream ended.
try:
    import modal

    _results = modal.Dict.from_name("layton-ai-results", create_if_missing=True)
except Exception:  # pragma: no cover - storage is an enhancement, not a need
    _results = None

RESULT_TTL_SECONDS = 14 * 24 * 3600
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

# The launcher supplies the same checkpoint it passes to vLLM.
MODEL = os.environ["LAYTON_MODEL"]
VLLM = "http://127.0.0.1:8001"
MAX_PROMPT_CHARS = 400_000
MAX_GEN_TOKENS = 8192
MAX_MODEL_LEN = int(os.environ.get("LAYTON_MAX_MODEL_LEN", "131072"))
ENVELOPE_VERSION = 1

API_KEY = os.environ["VLLM_API_KEY"]
_private_key = serialization.load_der_private_key(
    base64.b64decode(os.environ["LAYTON_E2E_PRIVATE_KEY_DER_B64"]), password=None
)

app = FastAPI()


def derive_keys(epk_raw: bytes) -> tuple[bytes, bytes]:
    peer = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk_raw)
    shared = _private_key.exchange(ec.ECDH(), peer)

    def kdf(info: bytes) -> bytes:
        # salt=None is HKDF's all-zero default, which is also what the client's
        # empty-salt WebCrypto call means: HMAC pads both to the same block.
        return HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None, info=info
        ).derive(shared)

    return kdf(b"layton-ai/request"), kdf(b"layton-ai/response")


def unseal(key: bytes, envelope: bytes) -> bytes:
    if len(envelope) <= 13 or envelope[0] != ENVELOPE_VERSION:
        raise ValueError("bad envelope")
    return AESGCM(key).decrypt(envelope[1:13], envelope[13:], None)


def seal(key: bytes, plaintext: bytes) -> bytes:
    iv = os.urandom(12)
    return bytes([ENVELOPE_VERSION]) + iv + AESGCM(key).encrypt(iv, plaintext, None)


_vllm_ready = False


async def wait_for_vllm() -> bool:
    """Ride out a brief warm-up, but don't hold a request through a cold
    start — loading model weights takes minutes, and the client would
    rather hear "not yet" than watch a spinner that long."""
    global _vllm_ready
    if _vllm_ready:
        return True
    async with httpx.AsyncClient() as client:
        for _ in range(45):
            try:
                if (await client.get(f"{VLLM}/health")).status_code == 200:
                    _vllm_ready = True
                    return True
            except httpx.HTTPError:
                pass
            await asyncio.sleep(2)
    return False


def _loading_state() -> dict | None:
    """Where the boot is, read off vLLM's log tail.

    Three acts, in order: weights stream off the volume ("Loading safetensors
    checkpoint shards: 42%"), kernels compile (quiet in the log — minutes of
    apparent stillness after shards hit 100%), and CUDA graphs get captured
    ("Capturing CUDA graph shapes: 61%"). Reported so the person watching the
    toast knows the difference between progress and a hang.
    """
    try:
        with open("/tmp/vllm.log", "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 131072))
            tail = f.read().decode(errors="ignore")
    except OSError:
        return None
    if "Engine core initialization failed" in tail or "OutOfMemoryError" in tail:
        return {"stage": "failed", "pct": None}
    graphs = re.findall(r"Capturing CUDA graph[^:]*:\s*(\d+)%", tail)
    if graphs:
        return {"stage": "graphs", "pct": int(graphs[-1])}
    shards = re.findall(r"checkpoint shards:\s*(\d+)%", tail)
    if shards and int(shards[-1]) >= 100:
        return {"stage": "compile", "pct": None}
    if shards:
        return {"stage": "weights", "pct": int(shards[-1])}
    return None


@app.get("/health")
async def health() -> dict:
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            model_up = (await client.get(f"{VLLM}/health")).status_code == 200
    except httpx.HTTPError:
        model_up = False
    return {
        "wrapper": True,
        "model": model_up,
        "modelId": MODEL,
        "maxModelLen": MAX_MODEL_LEN,
        "loading": None if model_up else _loading_state(),
    }


@app.post("/complete")
async def complete(request: Request) -> Response:
    if request.headers.get("authorization") != f"Bearer {API_KEY}":
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
        req_key, res_key = derive_keys(base64.b64decode(body["epk"]))
        opened = json.loads(unseal(req_key, base64.b64decode(body["req"])))
        prompt = opened["prompt"]
        if not (isinstance(prompt, str) and prompt.strip()):
            raise ValueError("empty prompt")
        max_tokens = opened.get("maxTokens", 1024)
        if not isinstance(max_tokens, int):
            raise ValueError("bad maxTokens")
        max_tokens = max(16, min(MAX_GEN_TOKENS, max_tokens))
        gen_id = opened.get("gen") or ""
        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", gen_id):
            gen_id = ""
    except Exception:
        return JSONResponse({"error": "bad envelope"}, status_code=400)

    if not await wait_for_vllm():
        return JSONResponse({"error": "model still loading"}, status_code=503)

    def line(obj: dict) -> bytes:
        """One NDJSON line: a sealed envelope, base64, newline-framed. Every
        line — text deltas, the final diagnostics, even mid-stream errors —
        is ciphertext to everything between here and the browser."""
        return base64.b64encode(seal(res_key, json.dumps(obj).encode())) + b"\n"

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

    # The generation runs as its own task, decoupled from this connection: a
    # closed tab stops the *stream* but not the writing. The finished text is
    # sealed and stored under the generation id, where /result can find it.
    queue: asyncio.Queue = asyncio.Queue()

    async def run_generation():
        finish = None
        usage: dict = {}
        parts: list[str] = []
        try:
            async with httpx.AsyncClient(timeout=900) as client:
                async with client.stream(
                    "POST",
                    f"{VLLM}/v1/completions",
                    headers={"Authorization": f"Bearer {API_KEY}"},
                    json=payload,
                ) as r:
                    if r.status_code != 200:
                        await queue.put({"error": "model error"})
                        return
                    async for raw in r.aiter_lines():
                        if not raw.startswith("data: "):
                            continue
                        data = raw[len("data: "):].strip()
                        if data == "[DONE]":
                            break
                        obj = json.loads(data)
                        if obj.get("usage"):
                            usage = obj["usage"]
                        choices = obj.get("choices") or []
                        if choices:
                            if choices[0].get("finish_reason"):
                                finish = choices[0]["finish_reason"]
                            if choices[0].get("text"):
                                parts.append(choices[0]["text"])
                                await queue.put({"t": choices[0]["text"]})
        except httpx.HTTPError:
            await queue.put({"error": "model connection lost"})
            return
        done = {
            "done": True,
            "finishReason": finish,
            "promptTokens": usage.get("prompt_tokens"),
            "completionTokens": usage.get("completion_tokens"),
        }
        await queue.put(done)
        if _results is not None and gen_id:
            try:
                stored = seal(
                    res_key,
                    json.dumps({"text": "".join(parts), **done}).encode(),
                )
                _results[gen_id] = {
                    "t": time.time(),
                    "res": base64.b64encode(stored).decode(),
                }
                # Opportunistic sweep so the store never just accumulates.
                now = time.time()
                for key, value in list(_results.items()):
                    if now - value.get("t", 0) > RESULT_TTL_SECONDS:
                        _results.pop(key)
            except Exception:
                pass

    task = asyncio.create_task(run_generation())
    if gen_id:
        _active[gen_id] = task
        task.add_done_callback(lambda _t: _active.pop(gen_id, None))

    async def relay():
        while True:
            item = await queue.get()
            yield line(item)
            if item.get("done") or item.get("error"):
                break

    return StreamingResponse(relay(), media_type="application/x-ndjson")


_active: dict[str, asyncio.Task] = {}


@app.get("/result/{gen_id}")
async def result(gen_id: str, request: Request) -> JSONResponse:
    """What became of a generation: its sealed text, a "still writing", or a
    shrug. The blob can only be opened by a key wrapped inside the book that
    asked for it, so even this store learns nothing from what it holds."""
    if request.headers.get("authorization") != f"Bearer {API_KEY}":
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if _results is not None:
        try:
            entry = _results.get(gen_id)
        except Exception:
            entry = None
        if entry:
            return JSONResponse({"status": "ready", "res": entry["res"]})
    if gen_id in _active:
        return JSONResponse({"status": "pending"})
    return JSONResponse({"status": "gone"})
