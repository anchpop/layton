import { z } from "zod";
import { base64ToBytes } from "../../src/lib/bytes";
import { importContentKey } from "../../src/lib/crypto";
import { database, json, keysSchema, readJson, READ_SCOPE, WRITE_SCOPE, type McpEnv, type McpProps } from "./common";

async function parseAuthorization(env: McpEnv, origin: string, query: string) {
  if (query.length > 16_384) throw new Error("Invalid authorization request");
  const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(`${origin}/oauth/authorize?${query}`));
  if (parsed.responseType !== "code" || parsed.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.codeChallenge ?? "")) {
    throw new Error("Authorization requires PKCE S256");
  }
  if (parsed.scope.some(scope => scope !== READ_SCOPE && scope !== WRITE_SCOPE)) throw new Error("Unsupported scope");
  if (parsed.scope.includes(WRITE_SCOPE) && !parsed.scope.includes(READ_SCOPE)) throw new Error("Editing requires read access");
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) throw new Error("Unknown client");
  return { parsed, client };
}

export async function authorization(request: Request, env: McpEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/oauth/authorize" && request.method === "GET") {
    await parseAuthorization(env, url.origin, url.search.slice(1));
    return new Response(null, { status: 302, headers: {
      Location: `${url.origin}/connect${url.search}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } });
  }
  if (url.pathname === "/api/mcp/request" && request.method === "GET") {
    const { parsed, client } = await parseAuthorization(env, url.origin, url.search.slice(1));
    return json({ clientName: (client.clientName || "MCP client").slice(0, 200), redirectUri: parsed.redirectUri, canEdit: parsed.scope.length === 0 || parsed.scope.includes(WRITE_SCOPE) });
  }
  if (url.pathname !== "/api/mcp/authorize" || request.method !== "POST") return null;
  // The browser explicitly submits fresh consent with a Supabase bearer token.
  // No ambient cookie can authorize a client, and cross-origin posts are denied.
  if (request.headers.get("Origin") !== url.origin || !request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "Invalid origin" }, 403);
  const input = z.object({ query: z.string(), includePrivate: z.boolean(), keys: keysSchema.optional(), deny: z.boolean().optional() }).strict().parse(await readJson(request));
  const { parsed, client } = await parseAuthorization(env, url.origin, input.query);
  if (input.deny) {
    const redirect = new URL(parsed.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    if (parsed.state) redirect.searchParams.set("state", parsed.state);
    if (parsed.issuer) redirect.searchParams.set("iss", parsed.issuer);
    return json({ redirectTo: redirect.href });
  }
  const canEdit = parsed.scope.length === 0 || parsed.scope.includes(WRITE_SCOPE);
  const keys = keysSchema.parse(input.keys);
  if (input.includePrivate !== (keys.privateKey !== undefined)) return json({ error: "Private access does not match the delegated keys" }, 400);
  const bearer = request.headers.get("Authorization") ?? "";
  if (!bearer.startsWith("Bearer ")) return json({ error: "Sign in again" }, 401);
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: bearer, apikey: env.SUPABASE_PUBLISHABLE_KEY }, signal: AbortSignal.timeout(10_000),
  });
  if (!who.ok) return json({ error: "Sign in again" }, 401);
  const { id: userId } = z.object({ id: z.uuid() }).parse(await readJson(who));
  // Validate key sizes using WebCrypto before persisting a grant. The browser
  // verifies the password by decrypting its authenticated vault record.
  await importContentKey(base64ToBytes(keys.everydayKey));
  if (keys.privateKey) await importContentKey(base64ToBytes(keys.privateKey));
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))), b => b.toString(16).padStart(2, "0")).join("");
  const name = (client.clientName || "MCP client").slice(0, 200);
  const connectionId = z.uuid().parse(await database(env, "rpc/create_mcp_edit_connection", {
    p_client_id: parsed.clientId, p_client_name: name, p_redirect_uri: parsed.redirectUri,
    p_secret_hash: hash, p_include_private: input.includePrivate, p_can_edit: canEdit,
  }, bearer));
  const props: McpProps = { userId, connectionId, secret, ...keys, includePrivate: input.includePrivate, scope: READ_SCOPE, canEdit, clientId: parsed.clientId, clientName: name };
  try {
    // Renew stored client metadata too, so its old 90-day TTL cannot cut a new
    // 12-month connection short. CIMD clients manage their own metadata URL.
    if (!parsed.clientId.startsWith("https://")) await env.OAUTH_PROVIDER.updateClient(parsed.clientId, {});
    const result = await env.OAUTH_PROVIDER.completeAuthorization({
      request: parsed, userId, scope: canEdit ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE], props,
      metadata: { connectionId, clientName: name, includePrivate: input.includePrivate, canEdit },
      // Database replacement above is authoritative; preserve other devices.
      revokeExistingGrants: false,
    });
    return json(result);
  } catch {
    const cleanup = await fetch(`${env.SUPABASE_URL}/rest/v1/mcp_connections?id=eq.${connectionId}`, {
      method: "DELETE", headers: { Authorization: bearer, apikey: env.SUPABASE_PUBLISHABLE_KEY },
    });
    if (!cleanup.ok) { /* Inert orphan expires in 12 months; never log credentials. */ }
    return json({ error: "Could not connect. Please try again." }, 503);
  }
}
