import assert from "node:assert/strict";
import { test } from "node:test";
import { handshake, verifyStatement, sealRequest, StreamVerifier, textHash, openResult, VERSION, type KeyStatement } from "../src/lib/ai-protocol";
import { importContentKey, seal, unseal } from "../src/lib/crypto";
import { bytesToBase64, base64ToBytes } from "../src/lib/bytes";
import relay from "../worker/relay";

const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const decode = (x: Uint8Array) => JSON.parse(new TextDecoder().decode(x));
const aad = (gen: string, type: string, seq: number) => encode([VERSION, gen, type, seq]);
async function server() {
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const statement: KeyStatement = { version: 2, keyId: "ab".repeat(16),
    publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    expiresAt: Math.floor(Date.now() / 1000) + 3600, signature: "" };
  statement.signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey,
    encode([2, statement.keyId, statement.publicKey, statement.expiresAt]))));
  const pin = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", signer.publicKey)));
  return { statement, pin, pair };
}

test("signed keys reject tampering, expiration, wrong pin, and placeholder", async () => {
  const s = await server();
  await verifyStatement(s.statement, s.pin);
  for (const patch of [{ version: 1 }, { keyId: "cd".repeat(16) }, { expiresAt: s.statement.expiresAt - 1 }, { publicKey: (await server()).statement.publicKey }])
    await assert.rejects(verifyStatement({ ...s.statement, ...patch }, s.pin));
  await assert.rejects(verifyStatement(s.statement, s.pin, s.statement.expiresAt));
  await assert.rejects(verifyStatement(s.statement, (await server()).pin));
  await assert.rejects(verifyStatement(s.statement));
});

test("transcript HKDF separates purposes; padded request authenticates generation; retries keep stored key", async () => {
  const { statement, pair } = await server();
  const session = await handshake(statement);
  // BookView wraps the result key before sending, but must not wipe it until
  // all requests/rehandshakes finish. Recovery uses this already-wrapped key.
  const bookKey = await importContentKey(crypto.getRandomValues(new Uint8Array(32)));
  const markerKey = await seal(bookKey, session.resKeyRaw);
  const peer = await crypto.subtle.importKey("raw", base64ToBytes(session.epk) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const derive = async (purpose: string, gen = session.gen) => importContentKey(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(),
    info: encode(["layton-ai", 2, statement.keyId, statement.publicKey, session.epk, gen, purpose]) }, hkdf, 256)));
  for (const prompt of ["Hi", "é".repeat(3000), "😀".repeat(5000)]) {
    const sealed = base64ToBytes(await sealRequest(session, prompt, 200));
    const bytes = await unseal(await derive("request"), sealed, aad(session.gen, "request", 0));
    assert.equal(bytes.length & (bytes.length - 1), 0);
    assert.ok(bytes.length >= 4096);
    const opened = decode(bytes);
    assert.equal(opened.prompt, prompt);
    assert.equal(opened.gen, session.gen);
    assert.equal(opened.resultKey, bytesToBase64(session.resKeyRaw));
    await assert.rejects(unseal(await derive("stream"), sealed, aad(session.gen, "request", 0)));
    await assert.rejects(unseal(await derive("request", "another-gen"), sealed, aad(session.gen, "request", 0)));
    await assert.rejects(unseal(session.reqKey, sealed, aad("another-gen", "request", 0)));
  }
  const retry = await handshake((await server()).statement, session);
  assert.equal(retry.gen, session.gen);
  assert.equal(bytesToBase64(retry.resKeyRaw), bytesToBase64(session.resKeyRaw));
  assert.notEqual(retry.epk, session.epk);
  const result = bytesToBase64(await seal(session.resKey, encode({ done: true, text: "hello", hash: await textHash("hello") }), aad(session.gen, "result", 0)));
  const recoveredKey = await importContentKey(await unseal(bookKey, markerKey));
  session.resKeyRaw.fill(0); // caller finally, after the final request is sealed
  assert.equal((await openResult(recoveredKey, retry.gen, result)).text, "hello");
  assert.equal((await openResult(retry.resKey, retry.gen, result)).text, "hello");
  await assert.rejects(openResult(retry.resKey, "another-gen", result));
  await assert.rejects(openResult(retry.streamKey, retry.gen, result));
});

test("stream rejects reordering, duplicates, truncation, tamper, cross-gen, wrong hash and after-final", async () => {
  const key = await importContentKey(crypto.getRandomValues(new Uint8Array(32)));
  const gen = crypto.randomUUID();
  const frame = async (type: string, seq: number, value: unknown) => JSON.stringify({ type, seq,
    data: bytesToBase64(await seal(key, encode(value), aad(gen, type, seq))) });
  const first = await frame("delta", 0, { t: "Hello " });
  const second = await frame("delta", 1, { t: "world" });
  const final = await frame("final", 2, { done: true, count: 2, hash: await textHash("Hello world") });
  const valid = new StreamVerifier(key, gen);
  assert.equal(await valid.accept(first), "Hello ");
  assert.equal(await valid.accept(second), "world");
  await valid.accept(final);
  valid.finish();
  await assert.rejects(valid.accept(first));
  await assert.rejects(new StreamVerifier(key, gen).accept(second));
  await assert.rejects(new StreamVerifier(key, "another-gen").accept(first));
  const duplicate = new StreamVerifier(key, gen);
  await duplicate.accept(first);
  await assert.rejects(duplicate.accept(first));
  assert.throws(() => duplicate.finish());
  const bad = new StreamVerifier(key, gen);
  await bad.accept(first);
  await bad.accept(second);
  await assert.rejects(bad.accept(await frame("final", 2, { done: true, count: 2, hash: await textHash("wrong") })));
  const tampered = JSON.parse(first);
  tampered.data = tampered.data.slice(0, -4) + "AAAA";
  await assert.rejects(new StreamVerifier(key, gen).accept(JSON.stringify(tampered)));
  tampered.type = "final";
  await assert.rejects(new StreamVerifier(key, gen).accept(JSON.stringify(tampered)));
  await assert.rejects(new StreamVerifier(key, gen).accept(await frame("error", 0, { error: "model failed" })));
});

test("relay forwards only service headers, gates every route and never caches failures", async () => {
  const original = globalThis.fetch;
  const env = { MODAL_URL: "https://model.test", VLLM_API_KEY: "service-key",
    SUPABASE_URL: "https://auth.test", SUPABASE_PUBLISHABLE_KEY: "public" } as Env;
  const seen: { url: string; init?: RequestInit }[] = [];
  let authStatus = 200;
  let upstreamStatus = 200;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    if (fail) throw new Error("private error");
    seen.push({ url: String(url), init });
    return new Response("{}", { status: String(url).startsWith(env.SUPABASE_URL) ? authStatus : upstreamStatus });
  };
  try {
    for (const path of ["ai-key", "ai-health", "ai-result?id=11111111-1111-1111-1111-111111111111", "complete"]) {
      const request = () => new Request(`https://app.test/api/${path}`, { method: path === "complete" ? "POST" : "GET",
        headers: { Authorization: "Bearer user-token", Cookie: "identity", "X-Forwarded-For": "user-ip" },
        ...(path === "complete" ? { body: "ciphertext" } : {}) });
      const response = await relay.fetch(request(), env);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const headers = new Headers(seen.at(-1)!.init!.headers);
      // The service key replaces the user's token; the token never crosses.
      assert.equal(headers.get("authorization"), "Bearer service-key");
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("x-forwarded-for"), null);
      assert.equal(seen.at(-1)!.init!.redirect, "manual");
      authStatus = 401;
      const denied = await relay.fetch(request(), env);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("cache-control"), "no-store");
      authStatus = 200;
    }
    upstreamStatus = 409;
    assert.equal((await relay.fetch(new Request("https://app.test/api/complete", { method: "POST", headers: { Authorization: "Bearer user" }, body: "ciphertext" }), env)).status, 409);
    fail = true;
    const failed = await relay.fetch(new Request("https://app.test/api/ai-key", { headers: { Authorization: "Bearer user" } }), env);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("cache-control"), "no-store");
    assert.ok(!(await failed.text()).includes("private"));
  } finally { globalThis.fetch = original; }
});
