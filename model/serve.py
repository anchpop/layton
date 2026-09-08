"""Llama 3.1 70B (base, FP8) on Modal, served by vLLM on one H200.

The FP8 checkpoint (RedHatAI's quantization of Meta's base model, ungated)
weighs ~73GB, so weights live in a persistent Volume and are fetched once by
a CPU container:

    modal run model/serve.py::download_model

Then deploy the server:

    modal deploy model/serve.py

The public port is wrapper.py, a decrypting front door: clients seal their
prompt to this deployment's public key (private half in the `llama-e2e-key`
Modal secret), so relays in between carry only ciphertext. vLLM itself binds
to localhost. It's a *base* model — the wrapper calls /v1/completions with a
raw prompt. Requests must carry the bearer key from the `vllm-api-key` secret.
"""

import modal
from pathlib import Path

MODEL = "RedHatAI/Meta-Llama-3.1-70B-FP8"
N_GPU = 1
MAX_MODEL_LEN = 131072
PORT = 8000

# Retain the deployed app identity so Layton's URL and secrets keep working.
app = modal.App("llama-405b-base")

hf_cache = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("vllm-cache", create_if_missing=True)

download_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("huggingface_hub")
    .env({"HF_XET_HIGH_PERFORMANCE": "1"})
)

vllm_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12"
    )
    .uv_pip_install(
        "vllm==0.27.1",
        "huggingface_hub[hf_transfer]",
        # For the decrypting wrapper. fastapi/httpx ship with vLLM anyway;
        # cryptography is pinned by presence, not version, on purpose.
        "cryptography",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    .add_local_file(Path(__file__).resolve().with_name("wrapper.py"), "/root/wrapper.py")
)


@app.function(
    image=download_image,
    cpu=4,
    memory=8192,
    volumes={"/root/.cache/huggingface": hf_cache},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=4 * 60 * 60,
)
def download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL, max_workers=4)
    hf_cache.commit()


@app.function(
    image=vllm_image,
    gpu="H200",
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_cache,
    },
    secrets=[
        modal.Secret.from_name("huggingface-secret"),
        modal.Secret.from_name("vllm-api-key"),
        modal.Secret.from_name("llama-e2e-key"),
    ],
    # Idle GPUs shut down after 10 minutes; a fresh request cold-starts them
    # again (weights come from the Volume, so minutes, not a re-download).
    scaledown_window=10 * 60,
    timeout=60 * 60,
)
@modal.concurrent(max_inputs=32)
@modal.web_server(port=PORT, startup_timeout=45 * 60)
def serve():
    import os
    import subprocess

    # vLLM stays on localhost; only the decrypting wrapper faces the world.
    # Its output is teed to a file so the wrapper's /health can read weight-
    # loading progress out of it during a cold start.
    vllm_log = open("/tmp/vllm.log", "ab")
    subprocess.Popen(
        [
            "vllm",
            "serve",
            MODEL,
            "--tensor-parallel-size",
            str(N_GPU),
            "--max-model-len",
            str(MAX_MODEL_LEN),
            # Bound warmup/activation memory while keeping the 128k window.
            "--max-num-seqs",
            "4",
            "--max-num-batched-tokens",
            "4096",
            "--gpu-memory-utilization",
            "0.90",
            "--host",
            "127.0.0.1",
            "--port",
            str(PORT + 1),
        ],
        stdout=vllm_log,
        stderr=subprocess.STDOUT,
    )
    subprocess.Popen(
        [
            "uvicorn",
            "wrapper:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
        ],
        cwd="/root",
        env={**os.environ, "LAYTON_MODEL": MODEL, "LAYTON_MAX_MODEL_LEN": str(MAX_MODEL_LEN)},
    )
