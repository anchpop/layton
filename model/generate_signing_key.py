"""Run locally once; output is SECRET. Never commit or paste the private value.

uv run --with cryptography python model/generate_signing_key.py
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def main():
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    print("Modal secret layton-ai-signing-key (PRIVATE):")
    print("LAYTON_AI_SIGNING_KEY_DER_B64=" + base64.b64encode(private).decode())
    print("Browser AI_SIGNING_SPKI (PUBLIC):")
    print(base64.b64encode(public).decode())


if __name__ == "__main__":
    main()
