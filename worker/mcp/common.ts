import { z } from "zod";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type McpEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
export const READ_SCOPE = "stories:read";
export const WRITE_SCOPE = "stories:write";
const key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
export const keysSchema = z.object({ everydayKey: key, privateKey: key.optional() }).strict();
export const propsSchema = keysSchema.extend({
  userId: z.uuid(), connectionId: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/),
  includePrivate: z.boolean(), scope: z.literal(READ_SCOPE), canEdit: z.boolean().optional(), clientId: z.string().max(2048).optional(), clientName: z.string().max(200).optional(),
}).refine(p => p.includePrivate === (p.privateKey !== undefined));
export type McpProps = z.infer<typeof propsSchema>;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/** Bound the actual stream; Content-Length is untrusted and may be absent. */
export async function readJson(request: Request | Response, maxBytes = 32_768): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error("Body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function database(env: Env, path: string, body: unknown, bearer?: string): Promise<unknown> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json",
      ...(bearer ? { Authorization: bearer } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Connection expired or revoked. Reconnect Layton.");
    const detail = z.object({ code: z.string().optional() }).safeParse(await readJson(response));
    if (detail.success && detail.data.code === "40001") throw new Error("Story changed. Read it again before editing.");
    if (detail.success && detail.data.code === "23505") throw new Error("Operation ID already used with different input. Use a new ID for a new edit.");
    throw new Error("Could not read this story. Try again or open it in Layton to sync.");
  }
  return readJson(response, 24 * 1024 * 1024);
}

export function grantRead(env: Env, props: McpProps, operation: string, args: Record<string, unknown> = {}) {
  return database(env, "rpc/mcp_read", {
    p_connection_id: props.connectionId, p_secret: props.secret, p_operation: operation, ...args,
  });
}

export async function checkGrant(env: Env, props: McpProps) {
  const grant = z.object({ owner_id: z.uuid(), include_private: z.boolean(), can_edit: z.boolean().optional() }).parse(await grantRead(env, props, "check"));
  if (props.canEdit && !grant.can_edit) throw new Error("Editing requires a new connection with edit access.");
  if (grant.owner_id !== props.userId || grant.include_private !== props.includePrivate) throw new Error("Connection expired or revoked. Reconnect Layton.");
}
