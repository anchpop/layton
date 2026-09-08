/**
 * The relay between the editor's "continue with AI" button and the model
 * server on Modal.
 *
 * It cannot read what it relays. The browser seals the prompt to the model
 * server's public key (see lib/autocomplete.ts), and the reply comes back
 * sealed to a key only that browser holds — so this Worker, and Cloudflare
 * under it, carry opaque envelopes in both directions. What it does do: check
 * the Supabase token so only signed-in users spend GPU hours, attach the model
 * server's bearer key (held here so it isn't public), and pass the envelope
 * on. The check stops here — nothing about the account goes to the model
 * server, and nothing is logged or stored.
 *
 * worker/index.ts routes the existing AI endpoints here. MCP has its own
 * authorization and decryption path; the AI relay remains ciphertext-only.
 */

type Env = {
  /** The model server on Modal (wrapper.py's decrypting front door). */
  MODAL_URL: string;
  /** Bearer key for it — held here so GPU hours aren't public. */
  VLLM_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
};

/** Generous ceiling for a sealed 400k-char prompt; anything bigger is abuse. */
const MAX_BODY_BYTES = 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** True when the bearer token belongs to a live Supabase session. */
async function signedIn(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  // Is this a live session? Supabase answers; the answer goes no further.
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_PUBLISHABLE_KEY },
  });
  return who.ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Whether the model is up, and how far through loading it is. Gated the
    // same as completions: any request to the model server boots a GPU
    // container, so none of these routes can be free to strangers.
    if (url.pathname === "/api/ai-health" && request.method === "GET") {
      if (!(await signedIn(request, env))) {
        return json({ error: "Sign in to use this." }, 401);
      }
      const upstream = await fetch(`${env.MODAL_URL}/health`);
      if (!upstream.ok) return json({ error: "The model is unreachable." }, 503);
      return new Response(upstream.body, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // What became of an earlier generation whose tab closed mid-write: the
    // model server holds the sealed result for a while, keyed by the id the
    // browser minted. Only ciphertext passes through here, as ever.
    if (url.pathname === "/api/ai-result" && request.method === "GET") {
      if (!(await signedIn(request, env))) {
        return json({ error: "Sign in to use this." }, 401);
      }
      const id = url.searchParams.get("id") ?? "";
      if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) {
        return json({ error: "Bad id." }, 400);
      }
      const upstream = await fetch(
        `${env.MODAL_URL}/result/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${env.VLLM_API_KEY}` } },
      );
      if (!upstream.ok) return json({ error: "The model is unreachable." }, 503);
      return new Response(upstream.body, {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname !== "/api/complete" || request.method !== "POST") {
      return json({ error: "Not found." }, 404);
    }
    if (!(await signedIn(request, env))) {
      return json({ error: "Sign in to use this." }, 401);
    }

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: "Too much text to continue." }, 413);
    }

    const upstream = await fetch(`${env.MODAL_URL}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.VLLM_API_KEY}`,
      },
      body,
    });
    if (!upstream.ok) {
      // Most often the GPU container cold-starting after idle.
      return json({ error: "The model is waking up — try again in a minute." }, 503);
    }
    // Envelopes stream through as they arrive — this is what lets the client
    // show words appearing — and stay as opaque here as everything else.
    return new Response(upstream.body, {
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  },
};
