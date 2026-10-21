# AI continuation server

`serve.py` deploys Layton's base-model continuation service on Modal. The browser
sends encrypted raw prose; `wrapper.py` decrypts it beside vLLM, calls
`/v1/completions`, and encrypts the streamed response. The relay cannot decrypt it. Protocol v2 replaces the old static ECDH secret;
it is **not deployment-ready until the signing pin and secrets below are set**.

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

## Security protocol (v2)

- Each container generates a P-256 ECDH key in memory, rotates it hourly, and
  accepts only the immediately previous key for five more minutes. A background
  timer drops old references even without traffic; acceptance also checks the
  deadline on every request. Container restarts discard all ECDH keys. Python
  and the crypto library do not promise physical RAM zeroization.
- `GET /api/ai-key` relays `/key`. The browser verifies the pinned ECDSA P-256
  signing key, version and expiry before using or caching the server key.
  The signature covers UTF-8 JSON `[2,keyId,publicKey,expiresAt]`, without
  whitespace; `publicKey` is base64 uncompressed SEC1, expiry is Unix seconds,
  and the SHA-256 ECDSA signature is 64-byte IEEE P1363 `r || s` (not DER).
- Per-generation client ECDH plus HKDF-SHA256 derives independent request,
  stream, and stored-result keys. HKDF uses the empty salt and JSON info
  `["layton-ai",2,keyId,serverPublicKey,clientPublicKey,generationId,purpose]`,
  where purpose is `request`, `stream`, or `result`. Keys/public points use
  standard base64. Book/account envelopes are unchanged.
- AES-GCM uses the existing `[1][12-byte random IV][ciphertext + 16-byte tag]`
  envelope and AAD `[2,generationId,type,sequence]`. Types are `request`,
  `delta`, `final`, `error`, `result`; requests/results use sequence zero.
  Stream frames are newline-terminated JSON `{type,seq,data}`. The browser
  requires contiguous delta sequences and an authenticated final containing
  the delta `count` and base64 SHA-256 `hash` of concatenated UTF-8 text.
  It rejects truncation, replay, reordering, mismatched generation, and anything
  after final. Partial text is provisional until final verification.
- The sealed request includes its generation ID and result key. There is no
  timestamp: a replay must name a key ID from the last hour (older ones are
  erased) and an unclaimed generation ID, so it is refused without trusting
  anyone's clock. Requests are padded with JSON
  whitespace to power-of-two **byte** lengths, at least 4096 bytes, before
  encryption. Size and timing still leak; responses are not padded.
- An atomic Modal Dict `put(skip_if_exists=True)` claims the generation before
  inference. Claims fail closed on storage errors and are never released on
  failure. The distinct HTTP 409 `unknown_key` response is issued before claim;
  the browser refreshes/rehandshakes once, retaining the generation and original
  result key. That key is sent only inside the newly sealed request, so the
  existing pending marker (result key wrapped under the book key) still works.
  Duplicate claims and errors after key derivation are sealed error records.
  A 503 warm-up response happens before claim; waiting/resealing is safe.
- Sealed results are available for 14 days; expired reads delete the entry. The daily
  CPU-only `sweep_results` function physically deletes expired results and
  claims; normal sweep lag can add up to a day, and provider backups/deletion
  schedules are outside this code's control. A sweep outage does not extend
  read availability. Successful generation stores the result before final.
- Every route demands the service bearer key (`vllm-api-key` secret, held by
  the Worker as `VLLM_API_KEY`). The check runs in Python, so an unauthenticated
  request can still wake a GPU container — a cost exposure, not a privacy one.
  Modal proxy auth (`requires_proxy_auth=True`) would reject it at Modal's edge
  instead, but its tokens can only be created in the Modal dashboard. The Worker
  checks Supabase auth then sends only the service key, not cookies, user
  tokens, account IDs, or incoming IP headers. Redirects fail
  closed. Every AI response, including errors, carries `Cache-Control: no-store`.
  Cloudflare still knows which account requested a generation; the inference
  application gets no account identity. This is not traffic anonymization.
- vLLM request, output and access logging are explicitly disabled. Its engine
  exception path can still dump token IDs, so raw stdout/stderr are piped to a
  discard/sanitize reader, never persisted. Only rebuilt startup stage/percentage
  values go to `/tmp/layton-loading.json`. Wrapper access logs are disabled and
  its output discarded. Error frames contain fixed generic messages, never
  model/library error text. Core dumps are disabled for both children; the
  signing and service secrets are excluded from vLLM's environment (it would
  enforce `VLLM_API_KEY` itself if it saw it). Flags were checked against
  vLLM 0.27.1's [engine arguments](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/engine/arg_utils.py)
  and [HTTP arguments](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/entrypoints/openai/cli_args.py);
  the [exception dump](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/logging_utils/dump_input.py)
  is why disabling request logging alone is insufficient. Recheck on upgrades.

### Limits of the guarantee

The GPU process necessarily reads prompts and continuations in live memory.
This does not protect against Modal/provider access to live memory, an operator
modifying deployed code, a compromised browser, or a malicious web app update
replacing the pin or exfiltrating text. A provider-supplied browser bundle is
not independently attested. Python cannot guarantee immediate memory erasure.

Deleting ephemeral server private keys limits later decryption of recorded
traffic from compromise of the signing key alone; compromise within the hourly
key lifetime plus grace can expose that window. The signing key can authenticate
future attacker keys if stolen. Stored result keys are intentionally recoverable
from encrypted book markers, so result confidentiality also depends on book keys.
TLS, Modal and Cloudflare may retain operational metadata (IP/timing/length and
request routing); disabling application content logs is not a promise about all
provider telemetry. No plaintext prompt or result is intentionally persisted by
this application. vLLM's transient KV cache is not durable storage.

## Deploy (operator actions; not performed by these tests)

This is a coordinated, breaking protocol change. Existing v1 pending results
cannot be recovered by v2; allow pending continuations to finish before rollout.

1. Locally generate a **new ECDSA signing key**, not an ECDH encryption key:

   ```sh
   uv run --with cryptography python model/generate_signing_key.py
   ```

   Its output contains a private secret. Do not commit it, send it to logs/CI,
   or save it inside the repository. Put `LAYTON_AI_SIGNING_KEY_DER_B64` in the
   Modal secret named `layton-ai-signing-key`. Replace `AI_SIGNING_SPKI` in
   `src/lib/ai-protocol.ts` with the emitted **public** SPKI base64. Do not fetch
   the verification pin from `/key` or reuse the old ECDH key.
2. `vllm-api-key` (Modal) and `VLLM_API_KEY` (Worker) stay as they are. The old
   `llama-e2e-key` secret is no longer used; delete it after cutover.
3. Use a Modal SDK supporting atomic `Dict.put(skip_if_exists=True)` (source checked in installed 1.4.3; no SDK pin
   exists in this project). The app retains its historical `llama-405b-base`
   identity/URL. `max_containers=1` is deliberate: ephemeral keys are container-
   local. Do not scale horizontally without adding key-aware routing.
4. From the repository root with the Modal CLI authenticated, download weights
   on CPU only if needed, then deploy the server **and its CPU cleanup schedule**:

   ```sh
   modal run model/serve.py::download_model
   modal deploy model/serve.py
   ```

   Deploy the browser/Worker with the new public pin in the same maintenance
   window. The model service deploy is separate from the
   Cloudflare app workflow. Rotating the signing key similarly requires a
   coordinated pin update; old browser tabs must reload.
5. When explicitly authorized to incur GPU cost, verify signed `/key`, encrypted completion/recovery, rotation retry,
   and absence of content in runtime logs. **Even `/health` and `/key` start a
   GPU container**; don't poll after testing. This change has not been deployed
   or verified against live Modal/vLLM. Cold starts discard ephemeral keys;
   the browser's one unknown-key retry handles a stale cached statement.

## Local verification (no GPU)

```sh
pnpm build
pnpm lint
pnpm test:ai
pnpm test:mcp
uv run --with fastapi --with httpx --with cryptography \
  python -m unittest discover -s model -p 'test_*.py'
```

Node tests exercise WebCrypto signature/expiry checks, transcript-bound key
separation, byte padding, retry/result-key continuity, stream integrity and the
identity-free no-store Worker. Python tests use a local fake vLLM and Dict to
check canonical signatures, the service key on every route, rotation/grace,
replay races, sealed failures, result recovery/TTL and retry. They do not
validate GPU inference, physical storage deletion, or provider logging configuration.

The September 8, 2026 deployment smoke test verified the old 70B v1 service only;
it is **not** evidence that this new security protocol has shipped.
