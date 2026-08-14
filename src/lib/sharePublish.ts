import { LoroMap, type LoroDoc } from "loro-crdt";
import { createNodeFromLoroObj, type LoroNode } from "loro-prosemirror";

import { supabase, type SharedBookRow } from "./supabase";
import { base64ToBytes, bytesToBase64 } from "./bytes";
import {
  importContentKey,
  randomKeyBytes,
  seal,
  sealText,
  tryUnseal,
} from "./crypto";
import { bodiesMap, getTitle, readChapters } from "./book";
import { schema } from "./schema";
import { shareUrl, type SharedStory } from "./share";

/**
 * Creating and managing shares. The reader's half — fetching and decrypting a
 * link — lives in share.ts, kept free of these imports so the public page
 * never loads Loro.
 *
 * A share is the book *rendered*, not the book's document. Exporting the Loro
 * snapshot would be less code, but a Loro snapshot is the history: every
 * deleted paragraph, every discarded draft of a sentence, recoverable by
 * anyone who opens the file in a debugger. What was written and then unwritten
 * was never offered to the reader, so the export walks the current state into
 * plain ProseMirror JSON and shares only that.
 */

export type ShareLink = {
  id: string;
  url: string;
  createdAt: string;
  /** When its content was last set — creation, or the latest push. */
  updatedAt: string;
};

export function exportStory(doc: LoroDoc): SharedStory {
  const bodies = bodiesMap(doc);
  const chapters = readChapters(doc).map((entry) => {
    const body = bodies.get(entry.id);
    // A chapter that was never typed in has no nodeName yet — the sync plugin
    // writes it on first contact. Shared as an empty chapter, not an error.
    if (!(body instanceof LoroMap) || typeof body.get("nodeName") !== "string") {
      return { title: entry.title, body: null };
    }
    return {
      title: entry.title,
      body: createNodeFromLoroObj(
        schema,
        body as unknown as LoroNode,
        new Map(),
      ).toJSON() as unknown,
    };
  });
  return { v: 1, title: getTitle(doc), chapters };
}

/**
 * Freeze the book as it stands and publish the copy.
 *
 * The share key is minted here, put into the returned URL's fragment, and
 * stored only in sealed form: once under itself around the payload, and once
 * under the book's key so the owner can re-display this link later. The server
 * receives both envelopes and can open neither.
 */
export async function publishShare(
  doc: LoroDoc,
  bookId: string,
  ownerId: string,
  bookKey: CryptoKey,
): Promise<ShareLink> {
  const raw = randomKeyBytes();
  const shareKey = await importContentKey(raw);
  const id = crypto.randomUUID();

  const payload = await sealText(shareKey, JSON.stringify(exportStory(doc)));
  const wrapped = bytesToBase64(await seal(bookKey, raw));
  const url = shareUrl(id, raw);
  raw.fill(0);

  const { error } = await supabase.from("shared_books").insert({
    id,
    owner_id: ownerId,
    book_id: bookId,
    payload,
    wrapped_key: wrapped,
  });
  if (error) throw error;

  const now = new Date().toISOString();
  return { id, url, createdAt: now, updatedAt: now };
}

/**
 * Push the book as it stands today to an existing link.
 *
 * The link does not change — same id, same key in the same fragment — so every
 * copy of it already in a reader's hands starts showing the current story.
 * The share key comes back out of its wrapped copy, and the new payload is a
 * fresh envelope under it; the server swaps one ciphertext for another and
 * remains unable to read either.
 */
export async function updateShare(
  doc: LoroDoc,
  shareId: string,
  bookKey: CryptoKey,
): Promise<string> {
  const { data, error } = await supabase
    .from("shared_books")
    .select("wrapped_key")
    .eq("id", shareId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That link no longer exists.");

  const raw = await tryUnseal(bookKey, base64ToBytes(data.wrapped_key as string));
  if (!raw) throw new Error("Could not open that link's key.");
  const shareKey = await importContentKey(raw);
  raw.fill(0);

  const payload = await sealText(shareKey, JSON.stringify(exportStory(doc)));
  const updatedAt = new Date().toISOString();
  const { error: err } = await supabase
    .from("shared_books")
    .update({ payload, updated_at: updatedAt })
    .eq("id", shareId);
  if (err) throw err;
  return updatedAt;
}

/**
 * This book's shares, links rebuilt from the wrapped copies of their keys.
 * A wrapped key the book's key will not open is skipped rather than shown as a
 * link that cannot work — it should be impossible, but a damaged row must not
 * take the whole list down with it.
 */
export async function listShares(
  bookId: string,
  bookKey: CryptoKey,
): Promise<ShareLink[]> {
  const { data, error } = await supabase
    .from("shared_books")
    .select("id,wrapped_key,created_at,updated_at")
    .eq("book_id", bookId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as Pick<
    SharedBookRow,
    "id" | "wrapped_key" | "created_at" | "updated_at"
  >[];
  const links: ShareLink[] = [];
  for (const row of rows) {
    const raw = await tryUnseal(bookKey, base64ToBytes(row.wrapped_key));
    if (!raw) continue;
    links.push({
      id: row.id,
      url: shareUrl(row.id, raw),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    raw.fill(0);
  }
  return links;
}

/** Delete the copy. The link dies with it; the book is untouched. */
export async function revokeShare(id: string): Promise<void> {
  const { error } = await supabase.from("shared_books").delete().eq("id", id);
  if (error) throw error;
}
