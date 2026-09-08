# AI continuation server

`serve.py` deploys Layton's base-model continuation service on Modal. The browser
sends encrypted raw prose; `wrapper.py` decrypts it beside vLLM, calls
`/v1/completions`, and encrypts the streamed response. Model changes preserve the
existing `vllm-api-key` and `llama-e2e-key` Modal secrets and the browser public key.

The default is [RedHatAI/Meta-Llama-3.1-70B-FP8](https://huggingface.co/RedHatAI/Meta-Llama-3.1-70B-FP8),
the quantized **base** checkpoint, on one H200 with a 131,072-token context.
The wrapper receives its model ID and context limit from the launcher so they
cannot drift apart. Raw continuation does not use a chat template.

The Modal app still has its historical `llama-405b-base` name to preserve the
production endpoint. The model ID in `/health` identifies the loaded checkpoint;
the endpoint name does not. Updating this app replaces its eight-GPU configuration.

## Cost and alternatives

[Modal list prices](https://modal.com/pricing), checked September 8, 2026:

| Configuration | GPU cost per running hour |
| --- | ---: |
| Previous 405B FP8, eight H200s | $36.32 |
| Previous H100 fallback, eight H100s | $31.59 |
| 70B FP8, one H200 | $4.54 |

This is roughly 86–88% less GPU spend for the same running duration, excluding
CPU, RAM, storage and any account discounts. It is not a measured per-token saving
or a claim of equivalent writing quality. Containers scale to zero after ten idle
minutes; startup and that idle window are billable.

Other base checkpoints considered:

- [Qwen3-30B-A3B-Base](https://huggingface.co/Qwen/Qwen3-30B-A3B-Base): smaller sparse
  model, but its published base context is 32,768 tokens.
- [Laguna S 2.1-base](https://huggingface.co/poolside/Laguna-S-2.1-base): Poolside
  explicitly does not publish its weights. The public repository contains only
  the model card and license. Its FP8/INT4 chat variants are post-trained models.
- [Laguna M.1-base](https://huggingface.co/poolside/Laguna-M.1-base): available as a
  225B-parameter BF16 base model. Four H200s would cost about $18.16/hour; this is a
  sizing estimate, not a tested deployment. The public smaller Laguna XS models
  are post-trained.

## Deploy

Run from the Layton repository root with the Modal CLI authenticated to the
existing workspace. Download weights on CPU before deploying:

```sh
modal run model/serve.py::download_model
modal deploy model/serve.py
```

Both the download and serving functions share the existing Hugging Face volume.
The old weights may remain cached; nothing uses them after the new deployment.
Do not call the old deployment to establish a benchmark: even `/health` starts
its GPU container. Check deployment metadata to confirm replacement before making
requests to the endpoint.

Run the local encrypted-stream contract check without GPU access:

```sh
uv run --with fastapi --with httpx --with cryptography \
  python -m unittest discover -s model -p 'test_*.py'
```

Model service deployment is separate from the Cloudflare app workflow. Never copy
local `.env` files or private key files into this directory or the repository.

## Verified deployment

On September 8, 2026, the production endpoint reported the 70B checkpoint and a
131,072-token context; the container had exactly one NVIDIA H200. vLLM allocated
182,624 tokens of KV cache. A synthetic 40-token story opening produced a
128-token continuation, encrypted and decrypted using the browser's existing
public key and wire format. This checks operation, not comparative writing
quality or full-context generation performance. The old 405B model was not
started or benchmarked.
