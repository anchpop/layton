import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { LoroDoc, LoroMap, LoroList, LoroText } from "loro-crdt";
import { importContentKey, randomKeyBytes, seal, sealText, unseal } from "../src/lib/crypto";
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "../src/lib/bytes";

import { mcpHistory } from "../src/lib/mcpHistory";
import { schema } from "../src/lib/schema";
import { createNodeFromLoroObj, type LoroNode } from "loro-prosemirror";

const owner = "10000000-0000-4000-8000-000000000001";
const stranger = "10000000-0000-4000-8000-000000000002";
const ordinaryId = "20000000-0000-4000-8000-000000000001";
const privateId = "20000000-0000-4000-8000-000000000002";
const otherId = "20000000-0000-4000-8000-000000000003";
const absentId = "20000000-0000-4000-8000-000000000099";
const longChapterText = "The rain kept falling. ".repeat(3000) + "Finally, the sun came out.";

// Real PostgreSQL semantics for the migration, RLS, functions and triggers;
// local workerd for OAuth, KV, WebCrypto, MCP transport and Loro WASM.
test("OAuth MCP integration, database isolation, privacy and revocation", { timeout: 120_000 }, async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create table public.books(id uuid primary key, owner_id uuid references auth.users, title_cipher text, wrapped_key text, updated_at timestamptz default now(), archived_at timestamptz);
    create table public.book_updates(id bigint generated always as identity, book_id uuid references books, owner_id uuid references auth.users, kind text, payload text);
    create table public.user_keys(user_id uuid primary key references auth.users, salt text);
    insert into auth.users values ('${owner}'), ('${stranger}');
    insert into public.user_keys values ('${owner}', 'salt');
  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20260908000000_mcp_connections.sql", import.meta.url), "utf8"));
  const legacyId = crypto.randomUUID();
  await db.query("insert into mcp_connections(id,owner_id,client_id,client_name,redirect_uri,secret_hash) values($1,$2,'legacy','Legacy client','https://legacy.example',repeat('a',64))", [legacyId, owner]);
  await db.exec(await readFile(new URL("../supabase/migrations/20260908010000_mcp_editing.sql", import.meta.url), "utf8"));
  const legacy = (await db.query<{can_edit: boolean; lifetime: number}>("select can_edit, extract(epoch from expires_at-created_at)/86400 lifetime from mcp_connections where id=$1", [legacyId])).rows[0];
  assert.equal(legacy.can_edit, false); assert.equal(Number(legacy.lifetime), 30);
  await db.query("delete from mcp_connections where id=$1", [legacyId]);
  const everyday = randomKeyBytes(), privateRaw = randomKeyBytes();
  const ordinaryKeyRaw = randomKeyBytes();
  for (const [id, who, accountRaw, title] of [
    [ordinaryId, owner, everyday, "Ordinary story"],
    [privateId, owner, privateRaw, "Secret story"],
    [otherId, stranger, everyday, "Other account"],
  ] as const) {
    const bookRaw = id === ordinaryId ? ordinaryKeyRaw : randomKeyBytes();
    const bookKey = await importContentKey(bookRaw);
    await db.query("insert into books(id,owner_id,title_cipher,wrapped_key) values($1,$2,$3,$4)", [
      id, who, await sealText(bookKey, title), bytesToBase64(await seal(await importContentKey(accountRaw), bookRaw)),
    ]);
    const doc = new LoroDoc();
    doc.getMap("meta").set("title", title);
    doc.configTextStyle({ strong: { expand: "after" } });
    const chapter = doc.getMovableList("chapters").pushContainer(new LoroMap());
    const chapterId = crypto.randomUUID(); chapter.set("id", chapterId); chapter.set("title", "Chapter one");
    const body = doc.getMap("bodies").setContainer(chapterId, new LoroMap()); body.set("nodeName", "doc");
    const children = body.setContainer("children", new LoroList());
    const paragraph = children.pushContainer(new LoroMap()); paragraph.set("nodeName", "paragraph");
    const text = paragraph.setContainer("children", new LoroList()).pushContainer(new LoroText());
    text.insert(0, "deleted-secret"); doc.commit(); text.delete(0, text.length); text.insert(0, "A fox crossed the river."); text.mark({start: 2, end: 5}, "strong", true);
    const pending = children.pushContainer(new LoroMap()); pending.set("nodeName", "ai_pending");
    pending.setContainer("attributes", new LoroMap()).set("key", "NEVER-RETURN-THIS-KEY");
    if (id === ordinaryId) {
      const secondId = crypto.randomUUID();
      const second = doc.getMovableList("chapters").pushContainer(new LoroMap());
      second.set("id", secondId); second.set("title", "Chapter two");
      const secondBody = doc.getMap("bodies").setContainer(secondId, new LoroMap()); secondBody.set("nodeName", "doc");
      const secondParagraph = secondBody.setContainer("children", new LoroList()).pushContainer(new LoroMap()); secondParagraph.set("nodeName", "paragraph");
      secondParagraph.setContainer("children", new LoroList()).pushContainer(new LoroText()).insert(0, longChapterText);
    }
    doc.commit();
    await db.query("insert into book_updates(book_id,owner_id,kind,payload) values($1,$2,'snapshot',$3)",
      [id, who, bytesToBase64(await seal(bookKey, doc.export({ mode: "snapshot" })))]);
    const version = doc.version(); text.insert(text.length, " Then it slept."); doc.commit();
    await db.query("insert into book_updates(book_id,owner_id,kind,payload) values($1,$2,'update',$3)",
      [id, who, bytesToBase64(await seal(bookKey, doc.export({ mode: "update", from: version })))]);
    doc.free();
  }
  let beforeWrite: (() => Promise<void>) | undefined;
  const upstream = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    try {
      if (request.url === "/auth/v1/user") {
        response.statusCode = request.headers.authorization === "Bearer test-login" ? 200 : 401;
        response.end(JSON.stringify({ id: owner })); return;
      }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw || "{}");
      if (request.url === "/rest/v1/rpc/mcp_write" && input.p_payload && beforeWrite) {
        const action = beforeWrite; beforeWrite = undefined; await action();
      }
      const authenticated = request.headers.authorization === "Bearer test-login";
      const value = await db.transaction(async tx => {
        await tx.exec(`set local role ${authenticated ? "authenticated" : "anon"}`);
        if (authenticated) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [owner]);
        if (request.url === "/rest/v1/rpc/create_mcp_edit_connection") {
          return (await tx.query<{ value: unknown }>("select public.create_mcp_edit_connection($1,$2,$3,$4,$5,$6) value", [input.p_client_id,input.p_client_name,input.p_redirect_uri,input.p_secret_hash,input.p_include_private,input.p_can_edit])).rows[0].value;
        }
        if (request.url === "/rest/v1/rpc/mcp_write") {
          return (await tx.query<{ value: unknown }>("select public.mcp_write($1,$2,$3,$4,$5,$6,$7,$8,$9) value", [input.p_connection_id,input.p_secret,input.p_book_id,input.p_operation_id,input.p_request_hash,input.p_wrapped_key,input.p_expected_revision,input.p_payload ?? null,input.p_title_cipher ?? null])).rows[0].value;
        }
        if (request.url === "/rest/v1/rpc/mcp_read") {
          return (await tx.query<{ value: unknown }>("select public.mcp_read($1,$2,$3,$4,$5) value", [input.p_connection_id,input.p_secret,input.p_operation,input.p_book_id ?? null,input.p_after ?? null])).rows[0].value;
        }
        throw new Error("Unknown fixture path");
      });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.statusCode = (error as { code?: string }).code === "42501" ? 403 : 400;
      response.end(JSON.stringify({ error: "fixture request failed", code: (error as {code?: string}).code }));
    }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => upstream.close());
  const upstreamPort = (upstream.address() as { port: number }).port;
  const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const port = (portProbe.address() as { port: number }).port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const state = await mkdtemp(join(tmpdir(), "layton-mcp-test-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const worker = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "127.0.0.1", "--port", String(port), "--local-upstream", `127.0.0.1:${port}`, "--upstream-protocol", "http", "--persist-to", state,
    "--var", `MCP_ORIGIN:${origin}`, "--var", `SUPABASE_URL:http://127.0.0.1:${upstreamPort}`, "--var", "SUPABASE_PUBLISHABLE_KEY:test-key"],
    { env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (worker.exitCode === null) { process.kill(-worker.pid!, "SIGTERM"); await once(worker, "exit"); } });
  let logs = "";
  worker.stdout.on("data", chunk => { logs = (logs + chunk).slice(-16_000); });
  worker.stderr.on("data", chunk => { logs = (logs + chunk).slice(-16_000); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs);
  const discovery = await fetch(`${origin}/mcp`);
  assert.equal(discovery.status, 401);
  assert.match(discovery.headers.get("WWW-Authenticate") ?? "", /resource_metadata=/);
  const meta = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(meta.resource, `${origin}/mcp`);
  assert.equal((await fetch(`${origin}/mcp`, { headers: { Origin: "https://evil.example" } })).status, 403);
  const registration = await fetch(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test AI app", redirect_uris: ["http://127.0.0.1:9876/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = bytesToBase64Url(randomKeyBytes());
  const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://127.0.0.1:9876/callback", response_type: "code", scope: "stories:read", code_challenge: challenge, code_challenge_method: "S256", state: "test-state", resource: `${origin}/mcp` });
  const details = await fetch(`${origin}/api/mcp/request?${query}`); assert.equal(details.status, 200);
  const malicious = new URLSearchParams(query); malicious.set("redirect_uri", "https://evil.example/callback");
  assert.equal((await fetch(`${origin}/oauth/authorize?${malicious}`, { redirect: "manual" })).status, 400);
  const wrongResource = new URLSearchParams(query); wrongResource.set("resource", "https://evil.example/mcp");
  assert.equal((await fetch(`${origin}/api/mcp/request?${wrongResource}`)).status, 400);
  const wrongScope = new URLSearchParams(query); wrongScope.set("scope", "stories:write");
  assert.equal((await fetch(`${origin}/api/mcp/request?${wrongScope}`)).status, 400);
  const missingPkce = new URLSearchParams(query); missingPkce.delete("code_challenge");
  assert.equal((await fetch(`${origin}/api/mcp/request?${missingPkce}`)).status, 400);
  async function authorize(includePrivate: boolean, canEdit = false) {
    const authQuery = new URLSearchParams(query);
    if (canEdit) authQuery.set("scope", "stories:read stories:write");
    const consent = await fetch(`${origin}/api/mcp/authorize`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Authorization: "Bearer test-login" },
      body: JSON.stringify({ query: authQuery.toString(), includePrivate, keys: { everydayKey: bytesToBase64(everyday), ...(includePrivate ? { privateKey: bytesToBase64(privateRaw) } : {}) } }) });
    assert.equal(consent.status, 200, await consent.clone().text());
    const redirect = new URL((await consent.json()).redirectTo); assert.equal(redirect.searchParams.get("state"), "test-state");
    const exchange = new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code: redirect.searchParams.get("code")!, code_verifier: verifier, redirect_uri: query.get("redirect_uri")!, resource: `${origin}/mcp` });
    const wrongAudience = new URLSearchParams(exchange); wrongAudience.set("resource", "https://evil.example/mcp");
    assert.equal((await fetch(`${origin}/oauth/token`, { method: "POST", body: wrongAudience })).status, 400);
    const wrong = new URLSearchParams(exchange); wrong.set("code_verifier", "x".repeat(43));
    assert.equal((await fetch(`${origin}/oauth/token`, { method: "POST", body: wrong })).status, 400);
    const token = await fetch(`${origin}/oauth/token`, { method: "POST", body: exchange });
    assert.equal(token.status, 200, await token.clone().text());
    return { ...await token.json(), exchange };
  }
  async function rpc(token: string, method: string, params?: unknown) {
    return fetch(`${origin}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  }
  async function tool(token: string, name: string, args = {}) {
    const response = await rpc(token, "tools/call", { name, arguments: args });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.ok(result.result, JSON.stringify(result));
    return { ...result.result, value: JSON.parse(result.result.content[0].text) };
  }
  const ordinary = await authorize(false);
  const init = await rpc(ordinary.access_token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200, await init.clone().text());
  const listing = await tool(ordinary.access_token, "list_stories");
  assert.deepEqual(listing.value.stories.map((s: { id: string }) => s.id), [ordinaryId]);
  const forbidden = await tool(ordinary.access_token, "read_story", { storyId: privateId });
  assert.equal(forbidden.isError, true);
  for (const storyId of [otherId, absentId]) {
    assert.deepEqual((await tool(ordinary.access_token, "read_story", { storyId })).value, forbidden.value);
  }
  const story = await tool(ordinary.access_token, "read_story", { storyId: ordinaryId });
  assert.equal(story.isError, undefined, JSON.stringify(story));
  assert.match(story.value.text, /A fox crossed the river\. Then it slept\./);
  assert.equal(story.value.text, `Chapter one\n\nA fox crossed the river. Then it slept.\n\nChapter two\n\n${longChapterText}`);
  assert.equal(story.value.chapters.length, 2);
  assert.equal(story.value.nextOffset, null);
  const chapterOnly = await tool(ordinary.access_token, "read_story", { storyId: ordinaryId, chapterId: story.value.chapters[1].id });
  assert.equal(chapterOnly.value.text, `Chapter two\n\n${longChapterText}`);
  assert.equal(chapterOnly.value.nextOffset, null);
  assert.doesNotMatch(JSON.stringify(story), /deleted-secret|NEVER-RETURN-THIS-KEY/);
  const search = await tool(ordinary.access_token, "search_story", { storyId: ordinaryId, query: "FOX" });
  assert.equal(search.value.matches.length, 1);
  const page = await tool(ordinary.access_token, "read_story", { storyId: ordinaryId, limit: 8 });
  assert.equal(page.value.text.length, 8); assert.equal(page.value.nextOffset, 8);
  const rest = await tool(ordinary.access_token, "read_story", { storyId: ordinaryId, offset: page.value.nextOffset });
  assert.equal(page.value.text + rest.value.text, story.value.text);
  assert.equal(rest.value.nextOffset, null);
  assert.equal((await fetch(`${origin}/oauth/token`, { method: "POST", body: ordinary.exchange })).status, 400, "authorization codes are one-use");
  assert.equal((await rpc(ordinary.access_token, "tools/list")).status, 401, "code replay revokes issued tokens");
  // Fresh edit consent and 12-month lifetime. Read-only tokens cannot discover
  // or invoke edit tools, and refresh cannot elevate a read-only grant.
  const writer = await authorize(false, true);
  const lifetime = (await db.query<{days: string}>("select extract(epoch from expires_at-created_at)/86400 days from mcp_connections")).rows[0];
  assert.ok(Number(lifetime.days) >= 365 && Number(lifetime.days) <= 366);
  assert.match(writer.scope, /stories:write/);
  const tools = await (await rpc(writer.access_token, "tools/list")).json();
  assert.ok(tools.result.tools.some((tool: {name: string}) => tool.name === "replace_text"));
  const chapterId = story.value.chapters[0].id;
  const editArgs = { storyId: ordinaryId, chapterId, expectedRevision: story.value.revision, operationId: crypto.randomUUID(), oldText: "fox", newText: "wolf" };
  const edited = await tool(writer.access_token, "replace_text", editArgs);
  assert.equal(edited.isError, undefined, JSON.stringify(edited));
  const replay = await tool(writer.access_token, "replace_text", editArgs);
  assert.equal(replay.value.replayed, true); assert.equal(replay.value.revision, edited.value.revision);
  const misuse = await tool(writer.access_token, "replace_text", { ...editArgs, newText: "owl" });
  assert.equal(misuse.isError, true); assert.match(misuse.value.error, /Operation ID/);
  const stale = await tool(writer.access_token, "append_to_chapter", { storyId: ordinaryId, chapterId, expectedRevision: story.value.revision, operationId: crypto.randomUUID(), text: "Stale overwrite" });
  assert.equal(stale.isError, true); assert.match(stale.value.error, /Story changed/);
  const updated = await tool(writer.access_token, "read_story", { storyId: ordinaryId });
  assert.match(updated.value.text, /A wolf crossed/);
  const appended = await tool(writer.access_token, "append_to_chapter", { storyId: ordinaryId, chapterId, expectedRevision: updated.value.revision, operationId: crypto.randomUUID(), text: "An owl watched. 😀\n\n* * *\n\nIt flew away." });
  assert.equal(appended.isError, undefined, JSON.stringify(appended));
  const renamed = await tool(writer.access_token, "rename_story", { storyId: ordinaryId, expectedRevision: appended.value.revision, operationId: crypto.randomUUID(), title: "A different title" });
  assert.equal(renamed.isError, undefined, JSON.stringify(renamed));
  const renamedChapter = await tool(writer.access_token, "rename_chapter", { storyId: ordinaryId, chapterId, expectedRevision: renamed.value.revision, operationId: crypto.randomUUID(), title: "Opening" });
  assert.equal(renamedChapter.isError, undefined);
  const newChapter = await tool(writer.access_token, "create_chapter", { storyId: ordinaryId, expectedRevision: renamedChapter.value.revision, operationId: crypto.randomUUID(), title: "Next", text: "A new beginning." });
  assert.equal(newChapter.isError, undefined, JSON.stringify(newChapter));
  assert.ok(newChapter.value.chapterId);
  const afterEdits = await tool(writer.access_token, "read_story", { storyId: ordinaryId });
  assert.equal(afterEdits.value.title, "A different title"); assert.equal(afterEdits.value.chapters.length, 3);
  const privateEdit = await tool(writer.access_token, "rename_story", { storyId: privateId, expectedRevision: "0", operationId: crypto.randomUUID(), title: "Must not change" });
  assert.equal(privateEdit.isError, true);
  const crossUserEdit = await tool(writer.access_token, "rename_story", { storyId: otherId, expectedRevision: "0", operationId: crypto.randomUUID(), title: "Must not change" });
  assert.equal(crossUserEdit.isError, true);
  // Re-import server-written ciphertext with the browser's Loro/ProseMirror
  // implementation; verify formatting, encrypted attribution, and compaction.
  const browserDoc = new LoroDoc();
  for (const row of (await db.query<{payload: string}>("select payload from book_updates where book_id=$1 order by id", [ordinaryId])).rows) {
    assert.doesNotMatch(row.payload, /A different title|Test AI app|mcp:edit/);
    browserDoc.import(await unseal(await importContentKey(ordinaryKeyRaw), base64ToBytes(row.payload)));
  }
  const pm = createNodeFromLoroObj(schema, browserDoc.getMap("bodies").get(chapterId) as LoroNode, new Map());
  assert.match(pm.textContent, /A wolf crossed.*An owl watched/s);
  const nodes: { text?: string; marks?: {type: string}[] }[] = pm.toJSON().content[0].content;
  assert.ok(nodes.some(node => node.text?.includes("wolf") && node.marks?.some(mark => mark.type === "strong")), JSON.stringify(nodes));
  const history = mcpHistory(browserDoc);
  assert.equal(history.length, 5); assert.ok(history.every(entry => entry.app === "Test AI app" && entry.timestamp > 0));
  const compacted = new LoroDoc(); compacted.import(browserDoc.export({mode: "snapshot"}));
  assert.deepEqual(mcpHistory(compacted), history); compacted.free();
  browserDoc.free();
  const raceDoc = new LoroDoc();
  for (const row of (await db.query<{payload: string}>("select payload from book_updates where book_id=$1 order by id", [ordinaryId])).rows) raceDoc.import(await unseal(await importContentKey(ordinaryKeyRaw), base64ToBytes(row.payload)));
  const browserVersion = raceDoc.version();
  raceDoc.getMap("meta").set("browserRace", true); raceDoc.commit();
  const browserUpdate = bytesToBase64(await seal(await importContentKey(ordinaryKeyRaw), raceDoc.export({mode: "update", from: browserVersion})));
  raceDoc.free();
  beforeWrite = async () => { await db.query("insert into book_updates(book_id,owner_id,kind,payload) values($1,$2,'update',$3)", [ordinaryId,owner,browserUpdate]); };
  const raced = await tool(writer.access_token, "rename_story", { storyId: ordinaryId, expectedRevision: afterEdits.value.revision, operationId: crypto.randomUUID(), title: "Concurrent overwrite" });
  assert.equal(raced.isError, true); assert.match(raced.value.error, /Story changed/);
  const afterRace = await tool(writer.access_token, "read_story", { storyId: ordinaryId });
  assert.equal(afterRace.value.title, "A different title", JSON.stringify(afterRace));
  const oldWrapping = (await db.query<{wrapped_key:string}>("select wrapped_key from books where id=$1", [ordinaryId])).rows[0].wrapped_key;
  beforeWrite = async () => { await db.query("update books set wrapped_key=$1 where id=$2", [bytesToBase64(await seal(await importContentKey(privateRaw), ordinaryKeyRaw)), ordinaryId]); };
  const privacyRace = await tool(writer.access_token, "rename_story", { storyId: ordinaryId, expectedRevision: afterRace.value.revision, operationId: crypto.randomUUID(), title: "Privacy race" });
  assert.equal(privacyRace.isError, true);
  await db.query("update books set wrapped_key=$1 where id=$2", [oldWrapping, ordinaryId]);
  beforeWrite = async () => { await db.query("delete from mcp_connections where owner_id=$1", [owner]); };
  const revokeRace = await tool(writer.access_token, "rename_story", { storyId: ordinaryId, expectedRevision: afterRace.value.revision, operationId: crypto.randomUUID(), title: "Revocation race" });
  assert.equal(revokeRace.isError, true);
  assert.equal((await db.query("select * from mcp_edit_receipts")).rows.length, 0, "revocation removes receipts");
  const scopedWriter = await authorize(false, true);
  const narrowedRefresh = await fetch(`${origin}/oauth/token`, {method: "POST", body: new URLSearchParams({grant_type: "refresh_token", client_id: client.client_id, refresh_token: scopedWriter.refresh_token, scope: "stories:read"})});
  assert.equal(narrowedRefresh.status, 200);
  const narrowed = await narrowedRefresh.json();
  const narrowedTools = await (await rpc(narrowed.access_token, "tools/list")).json();
  assert.ok(!narrowedTools.result.tools.some((tool: {name:string}) => tool.name === "replace_text"));
  const readOnly = await authorize(false);
  const readOnlyTools = await (await rpc(readOnly.access_token, "tools/list")).json();
  assert.ok(!readOnlyTools.result.tools.some((tool: {name: string}) => tool.name === "replace_text"));
  const blockedWrite = await (await rpc(readOnly.access_token, "tools/call", {name: "rename_story", arguments: { storyId: ordinaryId, expectedRevision: afterEdits.value.revision, operationId: crypto.randomUUID(), title: "Denied" }})).json();
  assert.ok(blockedWrite.error || blockedWrite.result?.isError);
  const all = await authorize(true);
  assert.equal((await rpc(ordinary.access_token, "tools/list")).status, 401, "reconsent invalidates old capabilities immediately");
  assert.equal((await tool(all.access_token, "list_stories")).value.stories.length, 2);
  assert.equal((await tool(all.access_token, "read_story", { storyId: privateId })).isError, undefined);
  const downgraded = await authorize(false);
  assert.equal((await rpc(all.access_token, "tools/list")).status, 401, "private access removed on downgrade");
  const refresh = await fetch(`${origin}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: downgraded.refresh_token, resource: `${origin}/mcp` }) });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.equal((await tool(refreshed.access_token, "list_stories")).value.stories.length, 1);
  await db.query("update books set wrapped_key=$1 where id=$2", [bytesToBase64(await seal(await importContentKey(privateRaw), ordinaryKeyRaw)), ordinaryId]);
  assert.equal((await tool(refreshed.access_token, "read_story", { storyId: ordinaryId })).isError, true);
  assert.equal((await tool(refreshed.access_token, "list_stories")).value.stories.length, 0);
  // Direct table and capability misuse, with real database RLS/privileges.
  await db.transaction(async tx => {
    await tx.exec("set local role anon");
    await assert.rejects(tx.query("select * from public.mcp_connections"));
  });
  await db.transaction(async tx => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [stranger]);
    assert.equal((await tx.query("delete from public.mcp_connections returning id")).rows.length, 0);
    assert.equal((await tx.query("select * from public.mcp_connections")).rows.length, 0);
  });
  const connection = (await db.query<{ id: string }>("select id from mcp_connections")).rows[0];
  await assert.rejects(db.query("select mcp_read($1, 'wrong-secret', 'list')", [connection.id]));
  await db.query("update user_keys set salt='new-salt' where user_id=$1", [owner]);
  assert.equal((await rpc(refreshed.access_token, "tools/list")).status, 401, "password change revokes MCP");
  const revoked = await authorize(false);
  await db.query("delete from mcp_connections where owner_id=$1", [owner]);
  assert.equal((await rpc(revoked.access_token, "tools/list")).status, 401);
  const revokedRefresh = await fetch(`${origin}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: revoked.refresh_token }) });
  assert.equal(revokedRefresh.status, 400, "revocation prevents refresh too");
  const expired = await authorize(false);
  await db.exec("update mcp_connections set expires_at=now()-interval '1 second'");
  assert.equal((await rpc(expired.access_token, "tools/list")).status, 401);
});
