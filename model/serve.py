"""Llama 3.1 70B (base, FP8) on Modal, served by vLLM on one H200.

The FP8 checkpoint (RedHatAI's quantization of Meta's base model, ungated)
weighs ~73GB, so weights live in a persistent Volume and are fetched once by
a CPU container:

    modal run model/serve.py::download_model

Then deploy the server:

    modal deploy model/serve.py

The public port is wrapper.py, an authenticated, encrypted front door. Every
route demands the bearer key from the `vllm-api-key` secret (held by the
Worker); the `layton-ai-signing-key` secret signs the hourly in-memory ECDH keys
browsers encrypt to. vLLM itself binds to localhost and receives no account
identity.
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
        modal.Secret.from_name("layton-ai-signing-key"),
    ],
    # Idle GPUs shut down after 10 minutes; a fresh request cold-starts them
    # again (weights come from the Volume, so minutes, not a re-download).
    max_containers=1,  # In-memory handshake keys must route to the same container.
    scaledown_window=10 * 60,
    timeout=60 * 60,
)
@modal.concurrent(max_inputs=32)
@modal.web_server(port=PORT, startup_timeout=45 * 60)
def serve():
    import os
    import subprocess
    import json
    import re
    import threading
    import resource

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    # vLLM's engine-error dumps include token IDs even with request logging
    # disabled. Consume and discard raw output; keep only rebuilt boot markers.
    process = subprocess.Popen(
        [
            "vllm",
            "serve",
            MODEL,
            "--no-enable-log-requests",
            "--no-enable-log-outputs",
            "--disable-uvicorn-access-log",
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
        # vLLM needs neither secret. It would also *enforce* VLLM_API_KEY if it
        # saw it, and only the wrapper, on localhost, ever talks to it.
        env={
            key: value
            for key, value in os.environ.items()
            if key not in ("LAYTON_AI_SIGNING_KEY_DER_B64", "VLLM_API_KEY")
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        # Universal newlines also split tqdm's carriage-return progress updates.
        text=True,
        errors="ignore",
    )
    def progress():
        for line in process.stdout:
            state = None
            if "Engine core initialization failed" in line or "OutOfMemoryError" in line:
                state = {"stage": "failed", "pct": None}
            elif match := re.search(r"Capturing CUDA graph[^:]*:\s*(\d+)%", line):
                state = {"stage": "graphs", "pct": min(100, int(match[1]))}
            elif match := re.search(r"checkpoint shards:\s*(\d+)%", line):
                pct = min(100, int(match[1]))
                state = {"stage": "compile" if pct == 100 else "weights", "pct": None if pct == 100 else pct}
            if state:
                with open("/tmp/layton-loading.json", "w") as file:
                    json.dump(state, file)
    threading.Thread(target=progress, daemon=True).start()
    subprocess.Popen(
        [
            "uvicorn",
            "wrapper:app",
            "--no-access-log",
            "--log-level",
            "critical",
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd="/root",
        env={**os.environ, "LAYTON_MODEL": MODEL, "LAYTON_MAX_MODEL_LEN": str(MAX_MODEL_LEN)},
    )


@app.function(image=modal.Image.debian_slim(), schedule=modal.Period(days=1))
def sweep_results():
    """CPU-only physical cleanup, including unused claims; never starts serve."""
    import time

    results = modal.Dict.from_name("layton-ai-results", create_if_missing=True)
    cutoff = time.time() - 14 * 24 * 3600
    for key, value in results.items():
        if value.get("t", 0) < cutoff:
            results.pop(key, None)
