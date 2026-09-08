"""CPU-only contract check; never contacts Modal or starts a model."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


class WrapperTest(unittest.IsolatedAsyncioTestCase):
    async def test_encrypted_raw_completion_uses_configured_model(self):
        server_key = ec.generate_private_key(ec.SECP256R1())
        private_der = server_key.private_bytes(
            serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        with patch.dict(os.environ, {
            "LAYTON_MODEL": "test/base-model",
            "LAYTON_MAX_MODEL_LEN": "131072",
            "VLLM_API_KEY": "test-only",
            "LAYTON_E2E_PRIVATE_KEY_DER_B64": base64.b64encode(private_der).decode(),
        }):
            spec = importlib.util.spec_from_file_location("test_wrapper_app", Path(__file__).with_name("wrapper.py"))
            wrapper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(wrapper)
        wrapper._results = None
        wrapper._vllm_ready = True

        peer = ec.generate_private_key(ec.SECP256R1())
        shared = peer.exchange(ec.ECDH(), server_key.public_key())
        def derive(label):
            return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=label).derive(shared)
        req_key, res_key = derive(b"layton-ai/request"), derive(b"layton-ai/response")
        prompt = "The lantern flickered as Mara opened the door."
        iv = os.urandom(12)
        sealed = b"\x01" + iv + AESGCM(req_key).encrypt(iv, json.dumps({"prompt": prompt, "maxTokens": 200}).encode(), None)
        envelope = {
            "epk": base64.b64encode(peer.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).decode(),
            "req": base64.b64encode(sealed).decode(),
        }
        seen = []
        def upstream(request):
            self.assertEqual(str(request.url), "http://127.0.0.1:8001/v1/completions")
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "test/base-model")
            self.assertEqual(payload["prompt"], prompt)
            self.assertNotIn("messages", payload)
            self.assertEqual(payload["truncate_prompt_tokens"], 131072 - 8192 - 64)
            seen.append(payload)
            chunks = [
                {"choices": [{"text": " Beyond it lay the sea.", "finish_reason": None}]},
                {"choices": [{"text": "", "finish_reason": "length"}], "usage": {"prompt_tokens": 12, "completion_tokens": 6}},
            ]
            return httpx.Response(200, text="".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n")
        client_class = httpx.AsyncClient
        async with client_class(transport=httpx.ASGITransport(app=wrapper.app), base_url="http://test") as client:
            denied = await client.post("/complete", json=envelope)
            self.assertEqual(denied.status_code, 401)
            with patch.object(wrapper.httpx, "AsyncClient", side_effect=lambda **kw: client_class(transport=httpx.MockTransport(upstream), **kw)):
                response = await client.post("/complete", headers={"Authorization": "Bearer test-only"}, json=envelope)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(seen), 1)
            self.assertNotIn("Beyond it", response.text)
            decoded = []
            for line in response.text.splitlines():
                sealed = base64.b64decode(line)
                self.assertEqual(sealed[0], 1)
                decoded.append(json.loads(AESGCM(res_key).decrypt(sealed[1:13], sealed[13:], None)))
            self.assertEqual(decoded[0]["t"], " Beyond it lay the sea.")
            self.assertTrue(decoded[-1]["done"])
            self.assertEqual(decoded[-1]["completionTokens"], 6)


if __name__ == "__main__":
    unittest.main()
