"""CPU-only protocol contracts. No Modal credentials, inference, or GPU calls."""
import asyncio
import base64
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


class Store(dict):
    def put(self, key, value, *, skip_if_exists=False):
        if skip_if_exists and key in self:
            return False
        self[key] = value
        return True


class WrapperTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.signer = ec.generate_private_key(ec.SECP256R1())
        private = self.signer.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        with patch.dict(os.environ, {"LAYTON_MODEL": "test/base-model", "VLLM_API_KEY": "service-key", "LAYTON_AI_SIGNING_KEY_DER_B64": base64.b64encode(private).decode()}), patch.dict(sys.modules, {"modal": None}):
            spec = importlib.util.spec_from_file_location("wrapper_app", Path(__file__).with_name("wrapper.py"))
            self.w = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.w)
        self.w._results = Store()
        self.client_class = httpx.AsyncClient
        self.client = self.client_class(transport=httpx.ASGITransport(app=self.w.app), base_url="http://test", headers={"Authorization": "Bearer service-key"})
        self.seen = []
        self.mode = "ok"

    async def asyncTearDown(self):
        await self.client.aclose()

    def envelope(self, *, gen="11111111-1111-1111-1111-111111111111", result_key=None):
        w = self.w
        statement = w._keys.statement()
        peer = ec.generate_private_key(ec.SECP256R1())
        epk = w.b64(peer.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        server = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(statement["publicKey"]))
        shared = peer.exchange(ec.ECDH(), server)
        transcript = [2, statement["keyId"], statement["publicKey"], epk, gen]
        keys = [HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=json.dumps(["layton-ai", *transcript, purpose], separators=(",", ":")).encode()).derive(shared) for purpose in ("request", "stream", "result")]
        opened = {"gen": gen, "prompt": "The lantern flickered.", "maxTokens": 200, "resultKey": w.b64(result_key or keys[2])}
        iv = os.urandom(12)
        ciphertext = b"\x01" + iv + AESGCM(keys[0]).encrypt(iv, json.dumps(opened).encode(), json.dumps([2, gen, "request", 0], separators=(",", ":")).encode())
        return {"version": 2, "gen": gen, "keyId": statement["keyId"], "epk": epk, "req": w.b64(ciphertext)}, keys

    def upstream(self, request):
        if request.url.path == "/health":
            return httpx.Response(200)
        self.assertEqual(str(request.url), "http://127.0.0.1:8001/v1/completions")
        payload = json.loads(request.content)
        self.seen.append(payload)
        self.assertEqual(payload["model"], "test/base-model")
        self.assertEqual(payload["prompt"], "The lantern flickered.")
        self.assertNotIn("messages", payload)
        self.assertNotIn("authorization", request.headers)
        self.assertEqual(payload["truncate_prompt_tokens"], 131072 - 8192 - 64)
        if self.mode == "error":
            return httpx.Response(500, text="SECRET PROMPT")
        if self.mode == "malformed":
            return httpx.Response(200, text="data: SECRET PROMPT\n\n")
        chunks = [{"choices": [{"text": " Beyond it lay the sea.", "finish_reason": None}]},
            {"choices": [{"text": "", "finish_reason": "length"}], "usage": {"prompt_tokens": 12, "completion_tokens": 6}}]
        return httpx.Response(200, text="".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + ("data: [DONE]\n\n" if self.mode != "truncated" else ""))

    async def post(self, envelope):
        with patch.object(self.w.httpx, "AsyncClient", side_effect=lambda **kw: self.client_class(transport=httpx.MockTransport(self.upstream), **kw)):
            return await self.client.post("/complete", json=envelope)

    def decode(self, response, key, gen):
        decoded = []
        for seq, line in enumerate(response.text.splitlines()):
            frame = json.loads(line)
            self.assertEqual(frame["seq"], seq)
            sealed = base64.b64decode(frame["data"])
            aad = json.dumps([2, gen, frame["type"], seq], separators=(",", ":")).encode()
            decoded.append((frame["type"], json.loads(AESGCM(key).decrypt(sealed[1:13], sealed[13:], aad))))
        self.assertTrue(decoded)
        if decoded[-1][0] != "error":
            self.assertEqual(decoded[-1][0], "final")
            self.assertTrue(all(kind == "delta" for kind, _ in decoded[:-1]))
            self.assertEqual(decoded[-1][1]["count"], len(decoded) - 1)
            text = "".join(value["t"] for _, value in decoded[:-1])
            self.assertEqual(decoded[-1][1]["hash"], base64.b64encode(hashlib.sha256(text.encode()).digest()).decode())
        return decoded

    async def test_frame_reordering_duplication_and_truncation(self):
        envelope, keys = self.envelope()
        response = await self.post(envelope)
        lines = response.text.splitlines()
        for broken in (lines[::-1], [lines[0], *lines], lines[:-1], [*lines, lines[-1]]):
            with self.assertRaises(AssertionError):
                self.decode(httpx.Response(200, text="\n".join(broken)), keys[1], envelope["gen"])

    async def test_signed_statement_and_rotation_grace(self):
        w = self.w
        response = await self.client.get("/key")
        self.assertEqual(response.headers["cache-control"], "no-store")
        statement = response.json()
        sig = base64.b64decode(statement["signature"])
        self.assertEqual(len(sig), 64)
        der = utils.encode_dss_signature(int.from_bytes(sig[:32]), int.from_bytes(sig[32:]))
        self.signer.public_key().verify(der, w.encode([2, statement["keyId"], statement["publicKey"], statement["expiresAt"]]), ec.ECDSA(hashes.SHA256()))
        old = statement["keyId"]
        with patch.object(w.time, "time", return_value=statement["expiresAt"]):
            new = w._keys.statement()
            self.assertNotEqual(old, new["keyId"])
            self.assertIsNotNone(w._keys.find(old))
        with patch.object(w.time, "time", return_value=statement["expiresAt"] + 300):
            self.assertIsNone(w._keys.find(old))
            self.assertIsNone(w._keys.previous)

    async def test_timer_retires_keys_without_traffic(self):
        old = self.w._keys.current
        with patch.object(self.w.time, "time", return_value=old["expiresAt"] + 300):
            async with self.w.lifespan(self.w.app):
                await asyncio.sleep(0)
                self.assertNotEqual(self.w._keys.current["keyId"], old["keyId"])
                self.assertIsNone(self.w._keys.previous)

    async def test_health_not_cached_after_engine_failure(self):
        for status in (200, 503):
            with patch.object(self.w.httpx, "AsyncClient", side_effect=lambda **kw: self.client_class(
                transport=httpx.MockTransport(lambda request: httpx.Response(status)), **kw
            )):
                self.assertEqual((await self.client.get("/health")).json()["model"], status == 200)

    async def test_loading_does_not_claim_generation(self):
        envelope, keys = self.envelope()
        async def not_ready():
            return False
        with patch.object(self.w, "wait_for_vllm", not_ready):
            response = await self.post(envelope)
        self.assertEqual(response.status_code, 503)
        self.assertFalse(self.w._results)
        self.assertFalse(self.seen)
        response = await self.post(envelope)
        self.assertEqual(self.decode(response, keys[1], envelope["gen"])[-1][0], "final")

    async def test_encrypted_completion_result_and_ttl(self):
        envelope, keys = self.envelope()
        response = await self.post(envelope)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Beyond", response.text)
        frames = self.decode(response, keys[1], envelope["gen"])
        self.assertEqual(frames[0], ("delta", {"t": " Beyond it lay the sea."}))
        self.assertEqual(frames[-1][0], "final")
        self.assertEqual(frames[-1][1]["count"], 1)
        result = await self.client.get("/result/" + envelope["gen"])
        self.assertEqual(result.json()["status"], "ready")
        opened = json.loads(self.w.unseal(keys[2], base64.b64decode(result.json()["res"]), self.w.aad(envelope["gen"], "result", 0)))
        self.assertEqual(opened["text"], " Beyond it lay the sea.")
        self.assertEqual(opened["hash"], frames[-1][1]["hash"])
        self.w._results[envelope["gen"]]["t"] -= self.w.RESULT_TTL_SECONDS
        self.assertEqual((await self.client.get("/result/" + envelope["gen"])).json()["status"], "gone")
        self.assertNotIn(envelope["gen"], self.w._results)

    async def test_replay_and_concurrent_claim(self):
        envelope, keys = self.envelope()
        first, second = await asyncio.gather(self.post(envelope), self.post(envelope))
        kinds = [self.decode(r, keys[1], envelope["gen"])[-1][0] for r in (first, second)]
        self.assertCountEqual(kinds, ["final", "error"])
        replay = await self.post(envelope)
        self.assertEqual(self.decode(replay, keys[1], envelope["gen"])[0][0], "error")
        self.assertEqual(len(self.seen), 1)

    async def test_every_route_requires_the_service_key(self):
        async with self.client_class(transport=httpx.ASGITransport(app=self.w.app), base_url="http://test") as anonymous:
            for path in ("/key", "/health", "/result/11111111-1111-1111-1111-111111111111"):
                response = await anonymous.get(path, headers={"Authorization": "Bearer wrong"})
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual((await anonymous.post("/complete", json={})).status_code, 401)

    async def test_unknown_key_and_tampering(self):
        envelope, keys = self.envelope()
        envelope["req"] = envelope["req"][:-4] + "AAAA"
        self.assertEqual(self.decode(await self.post(envelope), keys[1], envelope["gen"])[0][0], "error")
        envelope["keyId"] = "0" * 32
        self.assertEqual((await self.post(envelope)).status_code, 409)
        self.assertFalse(self.seen)
        self.assertFalse(self.w._results)

    async def test_fail_closed_when_claim_storage_unavailable(self):
        envelope, keys = self.envelope()
        self.w._results = None
        self.assertEqual(self.decode(await self.post(envelope), keys[1], envelope["gen"])[0][0], "error")
        self.assertFalse(self.seen)

    async def test_model_failures_are_sealed_and_not_saved(self):
        for mode in ("error", "malformed", "truncated"):
            self.mode = mode
            self.w._results.clear()
            envelope, keys = self.envelope()
            response = await self.post(envelope)
            self.assertNotIn("SECRET", response.text)
            self.assertEqual(self.decode(response, keys[1], envelope["gen"])[-1][0], "error")
            self.assertNotIn("res", self.w._results[envelope["gen"]])

    async def test_rehandshake_keeps_original_result_key(self):
        old, old_keys = self.envelope()
        self.w._keys.current = None
        self.w._keys.rotate()
        self.assertEqual((await self.post(old)).status_code, 409)
        fresh, keys = self.envelope(result_key=old_keys[2])
        response = await self.post(fresh)
        self.assertEqual(self.decode(response, keys[1], fresh["gen"])[-1][0], "final")
        result = (await self.client.get("/result/" + fresh["gen"])).json()
        self.w.unseal(old_keys[2], base64.b64decode(result["res"]), self.w.aad(fresh["gen"], "result", 0))
        with self.assertRaises(Exception):
            self.w.unseal(keys[2], base64.b64decode(result["res"]), self.w.aad(fresh["gen"], "result", 0))


if __name__ == "__main__":
    unittest.main()
