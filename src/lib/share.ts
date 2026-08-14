import { supabase } from "./supabase";
import { base64UrlToBytes, bytesToBase64Url } from "./bytes";
import { importContentKey, unsealText } from "./crypto";

/**
 * Reading a shared story. This module is deliberately free of Loro: a share's
 * payload is plain prose JSON, frozen at the moment it was made, so the reader
 * page can open it without the CRDT engine or its ~3 MB of wasm. The half that
 * *creates* shares needs the live document and lives in sharePublish.ts.
 *
 * The link is `/s/<id>#<key>`. Everything before the `#` reaches the server;
 * the fragment never does — that is a property of URLs, not of this code — so
 * the server stores and serves a payload it cannot read, same as everything
 * else it holds.
 */

/** A chapter as shared: its title and its ProseMirror doc JSON (null if empty). */
export type SharedChapter = { title: string; body: unknown | null };

export type SharedStory = {
  /** Format version, so an old link stays readable if the shape ever changes. */
  v: 1;
  title: string;
  chapters: SharedChapter[];
};

const SHARE_KEY_BYTES = 32;

export function shareUrl(id: string, keyRaw: Uint8Array): string {
  return `${location.origin}/s/${id}#${bytesToBase64Url(keyRaw)}`;
}

export type OpenedShare =
  /** The story, decrypted and ready to render. */
  | { kind: "ok"; story: SharedStory }
  /** The link has no key after the #, or not one this app ever minted. */
  | { kind: "bad-link" }
  /** No such share — revoked, or never existed. */
  | { kind: "missing" }
  /** The share exists but this key does not open it — a mangled fragment. */
  | { kind: "bad-key" }
  /** Could not ask. Offline, most likely. */
  | { kind: "error"; message: string };

/**
 * Fetch and decrypt one shared story.
 *
 * Every failure is classified rather than thrown, because each one tells the
 * reader to do something different: a missing share is gone for good, a bad
 * key means re-copy the link, an error means try again in a moment.
 */
export async function openShare(
  id: string,
  fragment: string,
): Promise<OpenedShare> {
  let keyRaw: Uint8Array;
  try {
    keyRaw = base64UrlToBytes(fragment);
  } catch {
    return { kind: "bad-link" };
  }
  if (keyRaw.length !== SHARE_KEY_BYTES) return { kind: "bad-link" };

  const { data, error } = await supabase.rpc("shared_book_payload", {
    p_id: id,
  });
  // An id that is not even a uuid fails Postgres's cast; to the reader that is
  // indistinguishable from a share that does not exist, because it is one.
  if (error) {
    return error.code === "22P02"
      ? { kind: "missing" }
      : { kind: "error", message: error.message };
  }
  if (typeof data !== "string") return { kind: "missing" };

  const key = await importContentKey(keyRaw);
  keyRaw.fill(0);
  try {
    const story = JSON.parse(await unsealText(key, data)) as SharedStory;
    if (story.v !== 1 || !Array.isArray(story.chapters)) {
      return { kind: "bad-link" };
    }
    return { kind: "ok", story };
  } catch {
    return { kind: "bad-key" };
  }
}
