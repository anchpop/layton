import { OAuthProvider, OAuthError } from "@cloudflare/workers-oauth-provider";
import relay from "./relay";
import { authorization } from "./mcp/authorization";
import { mcp } from "./mcp/server";
import { checkGrant, propsSchema, json, READ_SCOPE, WRITE_SCOPE, type McpEnv } from "./mcp/common";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/mcp/")) return relay.fetch(request, env);
    // Pin OAuth issuer, audiences, and consent origin to configured deployment.
    if (url.origin !== env.MCP_ORIGIN) return json({ error: "Invalid host" }, 403);
    const origin = request.headers.get("Origin");
    const allowedOrigins = [env.MCP_ORIGIN, ...env.MCP_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)];
    if (origin && !allowedOrigins.includes(origin)) return json({ error: "Invalid origin" }, 403);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
        "Access-Control-Max-Age": "600",
      } });
    }
    const provider = new OAuthProvider<McpEnv>({
      onError: ({ status, code }) => console.warn(JSON.stringify({ event: "oauth_error", status, code })),
      apiRoute: "/mcp",
      apiHandler: { fetch: (request, env, ctx) => mcp(request, env, ctx.props) },
      defaultHandler: { async fetch(request, env) {
        const response = await authorization(request, env);
        if (response) return response;
        const path = new URL(request.url).pathname;
        if (path.startsWith("/api/")) return relay.fetch(request, env);
        if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) return json({ error: "Not found" }, 404);
        const asset = await env.ASSETS.fetch(request);
        const secured = new Response(asset.body, asset);
        secured.headers.set("Referrer-Policy", "no-referrer");
        secured.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
        secured.headers.set("X-Frame-Options", "DENY");
        secured.headers.set("Cache-Control", "no-store");
        return secured;
      } },
      authorizeEndpoint: "/oauth/authorize", tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [READ_SCOPE, WRITE_SCOPE], allowImplicitFlow: false, allowPlainPKCE: false,
      tokenExchangeCallback: async ({ props, requestedScope }) => {
        if (!requestedScope.includes(READ_SCOPE)) throw new OAuthError("invalid_scope", { description: "stories:read is required" });
        const parsed = propsSchema.safeParse(props);
        if (!parsed.success) throw new OAuthError("invalid_grant", { description: "Reconnect Layton" });
        try { await checkGrant(env, parsed.data); }
        catch { throw new OAuthError("invalid_grant", { description: "Connection expired or revoked. Reconnect Layton." }); }
        return { accessTokenProps: { ...parsed.data, canEdit: !!parsed.data.canEdit && requestedScope.includes(WRITE_SCOPE) } };
      },
      accessTokenTTL: 900, refreshTokenTTL: 366 * 24 * 60 * 60, clientRegistrationTTL: 400 * 24 * 60 * 60,
      resourceMetadata: { resource: `${env.MCP_ORIGIN}/mcp`,
        scopes_supported: [READ_SCOPE, WRITE_SCOPE], bearer_methods_supported: ["header"], resource_name: "Layton stories" },
    });
    try {
      const response = await provider.fetch(request, env as McpEnv, ctx);
      const secured = new Response(response.body, response);
      secured.headers.set("Cache-Control", "no-store");
      if (origin) {
        secured.headers.set("Access-Control-Allow-Origin", origin);
        secured.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id");
        secured.headers.set("Vary", "Origin");
      }
      return secured;
    } catch {
      // No input or library exception text in logs/responses: OAuth props hold
      // delegated decryption keys. Return a generic failure to the caller.
      return json({ error: "Request failed. Check your connection and try again." }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
