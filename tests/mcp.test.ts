import test from "node:test";
import assert from "node:assert/strict";
import { randomKeyBytes, randomSalt, deriveMasterKey, importContentKey, seal, sealText } from "../src/lib/crypto";
import { bytesToBase64 } from "../src/lib/bytes";
import { delegateMcpKeys } from "../src/lib/mcpKeys";
import { openBookKey, type Book } from "../worker/mcp/books";
import { readJson, propsSchema } from "../worker/mcp/common";

test("ordinary consent never unwraps or sends a private key, even if its envelope is invalid", async () => {
  const salt = randomSalt();
  const master = await deriveMasterKey("correct password", salt, 1000);
  const everyday = randomKeyBytes();
  const record = { salt: bytesToBase64(salt), iterations: 1000,
    wrapped_key: bytesToBase64(await seal(master, everyday)), wrapped_private_key: "invalid" };
  const keys = await delegateMcpKeys(record, "correct password", false);
  assert.deepEqual(keys, { everydayKey: bytesToBase64(everyday) });
  await assert.rejects(delegateMcpKeys(record, "incorrect", false));
  await assert.rejects(delegateMcpKeys(record, "correct password", true));
  record.wrapped_private_key = bytesToBase64(await seal(master, randomKeyBytes()));
  assert.ok((await delegateMcpKeys(record, "correct password", true)).privateKey);
});

test("fresh wrapping enforces ordinary-to-private changes and explicit private consent", async () => {
  const everyday = randomKeyBytes(), privateRaw = randomKeyBytes(), bookRaw = randomKeyBytes();
  const everydayKey = await importContentKey(everyday), privateKey = await importContentKey(privateRaw);
  const book: Book = { id: crypto.randomUUID(), wrapped_key: bytesToBase64(await seal(everydayKey, bookRaw)),
    title_cipher: await sealText(await importContentKey(bookRaw), "Title"), updated_at: "now", archived_at: null };
  const ordinary = { everydayKey: bytesToBase64(everyday), includePrivate: false, privateKey: bytesToBase64(privateRaw) };
  assert.ok(await openBookKey(book, ordinary));
  book.wrapped_key = bytesToBase64(await seal(privateKey, bookRaw));
  assert.equal(await openBookKey(book, ordinary), null);
  assert.ok(await openBookKey(book, { ...ordinary, includePrivate: true }));
  assert.equal(propsSchema.safeParse({ ...ordinary, userId: crypto.randomUUID(), connectionId: crypto.randomUUID(), secret: "a".repeat(64), scope: "stories:read" }).success, false);
});

test("body limit applies to chunked input without Content-Length", async () => {
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"long":"'));
    controller.enqueue(new Uint8Array(100)); controller.close();
  } });
  await assert.rejects(readJson(new Response(stream), 20), /Body too large/);
});
