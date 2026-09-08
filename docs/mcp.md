# Layton MCP

The remote MCP endpoint is `https://layton.space/mcp`. It uses OAuth authorization
code flow with PKCE S256, audience-pinned tokens, authorization/resource discovery,
Client ID Metadata Documents, and dynamic client registration for older clients.
The tools include:

- `list_stories`: list stories or search their titles, with opaque pagination.
- `read_story`: pass only `storyId` to read every chapter in full, in order, with a chapter index and revision. Optional `chapterId`, `offset`, and `limit` support smaller reads; omitting `limit` returns all remaining text.
- `search_story`: search a story's current prose for a phrase, with excerpt pagination.
- `replace_text`: replace a unique exact match inside a paragraph.
- `append_to_chapter`: append paragraphs and scene breaks.
- `create_chapter`: add a chapter at the end of a story.
- `rename_story` and `rename_chapter`: update titles.

Editing requires `stories:write` as well as `stories:read`. Clients requesting
no scopes get both on fresh consent; clients explicitly requesting only read
access remain read-only. Existing tokens never acquire editing automatically.
Edit tools are omitted from read-only tool lists and are checked again at the
database write boundary. Narrowed refresh tokens cannot recover write access.

Only synced content is available. Archived stories are omitted from lists unless
requested. Story reads currently accept at most 16 MiB of encrypted update data;
larger stories return an error. A list page scans 100 database rows, and can be
empty with a continuation cursor. Clients should follow cursors until null.

## Consent and encryption

The user signs into Layton using the existing passkey or magic-link flow. The
consent screen shows the client name, requested read/edit access, and registered
return address, and asks for the master password. **Include private stories**
is unchecked, independently of whether private stories are unlocked in the app.

PBKDF2 and vault unwrapping happen in the browser. The password and master key
never leave it. Consent delegates the everyday account key, and only when checked,
the private account key, over HTTPS to the Worker. No private-key envelope is
unwrapped for ordinary-only consent. OAuth clients receive opaque tokens, not
content keys, Supabase access/refresh tokens, or a password.

The Worker stores delegated keys and a random database read capability in the
OAuth provider's encrypted `props`. These are encrypted under a per-grant key,
wrapped using token-derived key material. Grant metadata contains the account,
client name and private-access choice, but no key or prose. The hosted Worker
can decrypt authorized stories while processing MCP calls, and the connected AI
app receives their text. This is an explicit exception to the default encryption
boundary. A compromised authorized MCP runtime could retain content or keys;
encryption at rest does not remove that trust.

Every call checks a revocable, expiring database capability. Database access uses
the publishable key and a narrow `SECURITY DEFINER` read function; the Worker
holds no Supabase service-role key or reusable Supabase login. The function
checks the capability hash and expiration and reads only that owner's books. A separate write function accepts sealed
incremental updates only from capabilities authorized to edit. Neither returns
vault records. Snapshot and tail
reads share one PostgreSQL snapshot, preventing compaction between those reads.

The Worker re-reads the current book-key wrapping for every story request.
Ordinary-only grants cannot unwrap private books. There is no plaintext privacy
flag on books, and tool responses do not expose inaccessible IDs or titles.
Pagination cursors are encrypted. The Loro history is reconstructed transiently;
only current chapter text is rendered. Deleted text, AI pending-response keys,
and other CRDT metadata are excluded from tool output. No decrypted document or
book key is cached between requests.

## Lifetime and revocation

Access tokens last 15 minutes. New database capabilities expire after exactly
12 calendar months. Refresh tokens have a 366-day TTL; the database expiration
remains authoritative, so refresh cannot extend consent indefinitely. Stored
client registrations are renewed on consent for 400 days, keeping their lifetime
longer than the connection. Existing connections keep their original expiration
and read-only permissions until the user reauthorizes. Reconnect after expiration. Account → AI connections lists active
connections and revokes their database capability immediately. In-flight reads
may already have returned content; revocation cannot erase text an app retained.

Re-authorizing the same client and return address replaces its prior capability.
Unchecking private access therefore invalidates old tokens' data access even
before OAuth KV changes propagate. Changing or erasing the master-password vault
also revokes all capabilities. Signing out or locking the browser's private
library does not revoke MCP connections: this is explained on the consent page.

## Editing and history

Read a story to obtain its `revision`. Every edit takes that `expectedRevision`
and a fresh UUID `operationId`. Reuse both and the exact arguments on retries.
Writes lock the current book row and check its key wrapping and latest log id
atomically. A stale revision is rejected; reread before making a new edit.
Receipt records prevent duplicate appends even after compaction. Their request
fingerprint is an HMAC under the connection secret, not a guessable prose hash.
Revocation and writes serialize using the capability row lock. An edit already
in flight may finish before revocation completes; later edits are rejected.

Edits modify the existing Loro containers, export only their incremental CRDT
changes, and encrypt those changes under the book key. Formatting outside a
replacement is preserved; inserted replacement text inherits the first replaced
character's marks. Replacements are unique exact matches within a paragraph;
append/create tools handle new paragraphs. Concurrent unsynced browser edits
still merge through the usual CRDT protocol when they arrive.

Each real edit records a persisted Loro commit message containing its MCP
source, client name/id, connection id, operation id, action and chapter id when
applicable. Its timestamp is recorded too. These messages are inside the
**encrypted history**, survive snapshot compaction, and contain no credentials
or prose excerpts. A story's **AI edit history** panel displays the latest 100
entries with the app name, action and time. Client names are descriptive labels,
not proof of the client's publisher. Existing share exports still exclude CRDT
history, and MCP read tools still return only current story text.

## Set up and deploy

1. Apply `supabase/migrations/20260908000000_mcp_connections.sql` and
   `supabase/migrations/20260908010000_mcp_editing.sql` to the target Supabase
   project. This migration adds tables/functions and revocation triggers;
   it does not change existing story data. Review other pending migrations before
   running `supabase db push` (an older encryption migration deletes old data).
2. Apply the redirect allow-list in `supabase/config.toml` with `supabase config push`.
   Magic-link sign-in must be allowed to return to `https://layton.space/connect**`.
3. Run `pnpm install`, `pnpm build`, `pnpm test:mcp`, and `pnpm lint`.
4. Provision an OAuth KV namespace: `pnpm exec wrangler kv namespace create OAUTH_KV`.
   Put its returned namespace ID in the `OAUTH_KV` binding in `wrangler.jsonc`.
   Wrangler also supports automatic provisioning when the ID is omitted; pin it
   before unattended CI deployment so future deployments reuse the same namespace.
5. Run `pnpm exec wrangler deploy --dry-run`, then deploy the app and Worker with
   `pnpm run deploy`. No new static encryption secret or Supabase service-role secret
   is needed. Keep the existing AI relay secret configuration.
6. Add `https://layton.space/mcp` to an MCP client and choose OAuth. Verify both
   ordinary-only and private-inclusive consent using a test account, then revoke.

`MCP_ORIGIN` must match the deployment origin exactly. Native/server MCP clients
usually omit the HTTP Origin header. Browser clients need their exact origins
in the comma-separated `MCP_ALLOWED_ORIGINS` variable; consent POSTs always require
the Layton origin. OAuth endpoints and `/connect` bypass the PWA navigation cache.
Consent responses forbid framing and referrer transmission. Worker invocation
logs are disabled because OAuth query strings can contain authorization codes;
application code never logs tokens, delegated keys, database payloads, or prose.

## Local verification

After `pnpm build`, run `pnpm dev:mcp` and use `http://localhost:8787/mcp` in a client.
Wrangler serves the built app and Worker from one origin. Vite alone does not run
MCP, and its existing `/api` proxy still targets the deployed AI relay. The built
app uses your configured Supabase project, so use a development project for
interactive testing and apply the migration/redirect configuration there first.

`pnpm test:mcp` uses a temporary local Worker/KV directory and a PGlite PostgreSQL
database behind a mock Supabase HTTP boundary. It exercises the real migration,
OAuth provider, MCP transport, WebCrypto and Loro WASM without accessing live
accounts. It checks PKCE, one-use codes, audience discovery, private consent,
user isolation, snapshot/tail reconstruction, history exclusion, pagination,
refresh, downgrade, privacy changes, RLS, revocation and expiration. Editing
checks cover all tools, retry receipts, stale revisions, privacy/revocation races,
read-only grants, narrowed tokens, ProseMirror formatting, and attribution
surviving encrypted sync and compaction. The real
Supabase magic-link delivery and external MCP client UIs still need a deployment
smoke test. `pnpm typegen` regenerates the Worker binding types.

Protocol implementation references:
[Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider),
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[Cloudflare MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/).
