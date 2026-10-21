/**
 * The relay between the editor's "continue with AI" button and the model
 * server on Modal.
 *
 * It cannot read what it relays. The browser encrypts the prompt to an hourly
 * key that exists only in the model container's memory, after checking that
 * key's signature against a public key built into the app (lib/ai-protocol.ts)
 * — so a relay that swapped in its own key would fail that check. Replies come
 * back sealed to keys only the browser and that container derive. This Worker,
 * and Cloudflare under it, carry opaque envelopes in both directions.
 *
 * What it does do: check the Supabase token so only signed-in users spend GPU
 * hours, attach the model server's bearer key (held here so it isn't public),
 * and pass the envelope on. Nothing about the account, and no client header,
 * goes to the model server; nothing is logged or stored; nothing is cached.
 *
 * worker/index.ts routes the AI endpoints here. MCP has its own authorization
 * and decryption path; the AI relay remains ciphertext-only.
 */

/** Generous ceiling for a padded, sealed 400k-char prompt; bigger is abuse. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Browser path → model server path. Only /complete takes a body. */
const ROUTES: Record<string, string> = {
  "/api/ai-key": "/key",
  "/api/ai-health": "/health",
  "/api/ai-result": "/result",
  "/api/complete": "/complete",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** True when the bearer token belongs to a live Supabase session. */
async function signedIn(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  // Is this a live session? Supabase answers; the answer goes no further.
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_PUBLISHABLE_KEY },
    redirect: "error",
  });
  return who.ok;
}

/** The request body, or null past the ceiling — read without trusting Content-Length. */
async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Counted as it arrives, so an oversized upload is dropped, not buffered.
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      let path = ROUTES[url.pathname];
      const completion = path === "/complete";
      if (!path || request.method !== (completion ? "POST" : "GET")) {
        return json({ error: "Not found." }, 404);
      }
      // Every route is gated: any request to the model server can boot a GPU
      // container, so none of them can be free to strangers.
      if (!(await signedIn(request, env))) {
        return json({ error: "Sign in to use this." }, 401);
      }
      if (path === "/result") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return json({ error: "Bad id." }, 400);
        path += `/${encodeURIComponent(id)}`;
      }
      const body = completion ? await boundedBody(request) : undefined;
      if (body === null) return json({ error: "Too much text to continue." }, 413);

      const upstream = await fetch(`${env.MODAL_URL}${path}`, {
        method: completion ? "POST" : "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${env.VLLM_API_KEY}`,
          ...(completion ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });
      // The model container's hourly key rotated (or it restarted) between the
      // browser fetching the key and sending: the browser re-fetches and retries.
      if (completion && upstream.status === 409) return json({ error: "unknown_key" }, 409);
      // 503 mostly means the GPU container is cold-starting; the browser waits.
      if (!upstream.ok) {
        return json({ error: "The model is unavailable. Try again shortly." }, 503);
      }
      // Envelopes stream through as they arrive — that is what lets words
      // appear as they are written — and stay as opaque here as everything else.
      return new Response(upstream.body, {
        headers: {
          "Content-Type": completion ? "application/x-ndjson" : "application/json",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      // Nothing from a failed fetch (headers, upstream text) goes back out, and
      // the answer is still no-store.
      return json({ error: "The model is unreachable." }, 503);
    }
  },
};
