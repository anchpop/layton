import { z } from "zod";
import { base64ToBytes, bytesToBase64 } from "../../src/lib/bytes";
import { importContentKey, tryUnseal, unsealText, sealText, seal } from "../../src/lib/crypto";
import { database, grantRead, checkGrant, type McpProps } from "./common";

export const bookSchema = z.object({
  id: z.uuid(), wrapped_key: z.string(), title_cipher: z.string(),
  updated_at: z.string(), archived_at: z.string().nullable(),
});
export type Book = z.infer<typeof bookSchema>;

export async function openBookKey(book: Book, props: Pick<McpProps, "everydayKey" | "privateKey" | "includePrivate">): Promise<CryptoKey | null> {
  const everyday = await importContentKey(base64ToBytes(props.everydayKey));
  let raw = await tryUnseal(everyday, base64ToBytes(book.wrapped_key));
  if (!raw && props.includePrivate && props.privateKey) {
    raw = await tryUnseal(await importContentKey(base64ToBytes(props.privateKey)), base64ToBytes(book.wrapped_key));
  }
  if (!raw) return null;
  try { return await importContentKey(raw); } finally { raw.fill(0); }
}

export async function listStories(env: Env, props: McpProps, args: { cursor?: string; query?: string; includeArchived?: boolean }) {
  await checkGrant(env, props);
  const cursorKey = await importContentKey(base64ToBytes(props.everydayKey));
  // Encrypted cursors never disclose an inaccessible book's id to the client.
  const after = args.cursor ? z.uuid().parse(await unsealText(cursorKey, args.cursor)) : null;
  const books = z.array(bookSchema).parse(await grantRead(env, props, "list", { p_after: after }));
  const stories = [];
  for (const book of books) {
    if (book.archived_at && !args.includeArchived) continue;
    const key = await openBookKey(book, props);
    if (!key) continue;
    let title: string;
    try { title = await unsealText(key, book.title_cipher); } catch { continue; }
    if (args.query && !title.toLocaleLowerCase().includes(args.query.toLocaleLowerCase())) continue;
    stories.push({ id: book.id, title, updatedAt: book.updated_at, archived: !!book.archived_at });
  }
  await checkGrant(env, props);
  return { stories, nextCursor: books.length === 100 ? await sealText(cursorKey, books.at(-1)!.id) : null };
}

export async function loadStory(env: Env, props: McpProps, bookId: string) {
  await checkGrant(env, props);
  const data = z.object({ book: bookSchema, updates: z.array(z.object({ id: z.string().regex(/^\d+$/), payload: z.string() })) }).nullable()
    .parse(await grantRead(env, props, "read", { p_book_id: bookId }));
  if (!data) throw new Error("Story not found or unavailable.");
  const key = await openBookKey(data.book, props);
  // Same error for another owner's id, an unknown id, and a private story.
  if (!key) throw new Error("Story not found or unavailable.");
  return { ...data, key, revision: data.updates.at(-1)?.id ?? "0" };
}

export async function readStory(env: Env, props: McpProps, bookId: string) {
  const data = await loadStory(env, props, bookId);
  const { renderStory } = await import("./story");
  const chapters = await renderStory(data.key, data.updates);
  await checkGrant(env, props);
  return { id: bookId, title: await unsealText(data.key, data.book.title_cipher), chapters, revision: data.revision };
}

export async function editStory(env: Env, props: McpProps, args: {
  storyId: string; expectedRevision: string; operationId: string;
}, edit: import("./story").StoryEdit) {
  if (!props.canEdit) throw new Error("Editing requires a new connection with edit access.");
  const data = await loadStory(env, props, args.storyId);
  const macKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(props.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const fingerprint = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, new TextEncoder().encode(JSON.stringify({ storyId: args.storyId, expectedRevision: args.expectedRevision, edit }))));
  const requestHash = Array.from(fingerprint, b => b.toString(16).padStart(2, "0")).join("");
  const base = { p_connection_id: props.connectionId, p_secret: props.secret, p_book_id: args.storyId,
    p_operation_id: args.operationId, p_request_hash: requestHash, p_wrapped_key: data.book.wrapped_key,
    p_expected_revision: args.expectedRevision };
  const receiptSchema = z.object({ revision: z.string(), replayed: z.boolean() });
  const existing = receiptSchema.nullable().parse(await database(env, "rpc/mcp_write", base));
  const output = (receipt: z.infer<typeof receiptSchema>) => ({ storyId: args.storyId, ...receipt,
    ...(edit.kind === "create_chapter" ? { chapterId: args.operationId } : {}) });
  if (existing) return output(existing);
  if (data.revision !== args.expectedRevision) throw new Error("Story changed. Read it again before editing.");
  const { loadStoryDoc, applyStoryEdit } = await import("./story");
  const doc = await loadStoryDoc(data.key, data.updates);
  try {
    const update = applyStoryEdit(doc, edit, args.operationId, props);
    let payload: string;
    try { payload = bytesToBase64(await seal(data.key, update)); } finally { update.fill(0); }
    const receipt = receiptSchema.parse(await database(env, "rpc/mcp_write", {
      ...base, p_payload: payload,
      p_title_cipher: edit.kind === "rename_story" ? await sealText(data.key, edit.title) : null,
    }));
    return output(receipt);
  } finally { doc.free(); }
}
