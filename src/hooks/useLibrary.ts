import { useCallback, useEffect, useRef, useState } from "react";

import { supabase, type BookRow } from "../lib/supabase";
import { sealText, unsealText } from "../lib/crypto";
import {
  createBookKey,
  openBookKey,
  rewrapBookKey,
  status as vaultStatus,
} from "../lib/vault";
import { updateLocalWrappedKey } from "../lib/localStore";
import { useVaultStatus } from "./useVault";

/** A book this browser can actually read. Nothing else is representable. */
export type LibraryBook = {
  id: string;
  title: string;
  updated_at: string;
  isPrivate: boolean;
  /** Carried so the context menu can move the book between the two keys. */
  wrappedKey: string;
};

export function useLibrary(userId: string | null) {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { privateUnlocked } = useVaultStatus();
  /**
   * Only the newest refresh may write to state. Without this, one started while
   * the vault was unlocked can land after it has locked and put private titles
   * back on screen.
   */
  const latest = useRef(0);

  /**
   * Every row comes back sealed, and a row is listed only if a key in hand
   * opens it. With the private key put away those rows fail at exactly the same
   * point as a corrupted one, and are dropped in exactly the same silence —
   * no count, no placeholder, no "2 hidden" line to notice.
   *
   * That is deliberately not a filter on a flag. There is no flag; there is
   * nothing here to forget to check.
   */
  const refresh = useCallback(async () => {
    if (!userId) return;
    const run = ++latest.current;
    const { data, error: err } = await supabase
      .from("books")
      .select("*")
      .is("archived_at", null)
      .order("updated_at", { ascending: false });

    if (err) {
      if (run === latest.current) {
        setError(err.message);
        setLoading(false);
      }
      return;
    }

    const rows = (data ?? []) as BookRow[];
    const visible: LibraryBook[] = [];
    for (const row of rows) {
      const opened = await openBookKey(row.wrapped_key);
      if (!opened) continue;
      visible.push({
        id: row.id,
        title: await readTitle(opened.key, row.title_cipher),
        updated_at: row.updated_at,
        isPrivate: opened.isPrivate,
        wrappedKey: row.wrapped_key,
      });
    }

    if (run !== latest.current) return;
    // Checked here rather than at the top, against the vault as it is *now*:
    // decrypting a page of titles takes long enough for the lock to have
    // happened in between, and a row read while unlocked must not be rendered
    // by a callback that returns after.
    setBooks(
      vaultStatus().privateUnlocked
        ? visible
        : visible.filter((book) => !book.isPrivate),
    );
    setError(null);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    // Locking takes private books off the screen immediately, not once a
    // refresh comes back. Waiting for the server would leave them sitting there
    // whenever the request is slow, and permanently whenever it fails — which
    // offline it always does, and offline is exactly when a laptop is likeliest
    // to be somewhere it should not be left open.
    if (!privateUnlocked) {
      setBooks((current) => current.filter((book) => !book.isPrivate));
    }
    void refresh();
  }, [refresh, privateUnlocked]);

  const createBook = useCallback(
    async (title: string, isPrivate = false): Promise<LibraryBook | null> => {
      if (!userId) return null;
      // The id is minted here rather than by Postgres because the row cannot be
      // written until its title is sealed, and sealing needs the book's key.
      const id = crypto.randomUUID();
      const { key, wrapped } = await createBookKey(isPrivate);

      const { error: err } = await supabase.from("books").insert({
        id,
        owner_id: userId,
        title_cipher: await sealText(key, title),
        wrapped_key: wrapped,
      });
      if (err) {
        setError(err.message);
        return null;
      }
      await refresh();
      return { id, title, updated_at: new Date().toISOString(), isPrivate, wrappedKey: wrapped };
    },
    [userId, refresh],
  );

  /**
   * Move a book between ordinary and private.
   *
   * One column changes. The book's own key is not replaced, so the update log,
   * the cached snapshot and the title all stay exactly as they were — this is
   * a change of who can find the key, not of what it locks.
   */
  const setPrivate = useCallback(
    async (book: LibraryBook, isPrivate: boolean) => {
      try {
        const rewrapped = await rewrapBookKey(book.wrappedKey, isPrivate);
        const { error: err } = await supabase
          .from("books")
          .update({ wrapped_key: rewrapped })
          .eq("id", book.id);
        if (err) {
          setError(err.message);
          return false;
        }
        // Reclassified the moment the server agrees, before the cache write and
        // before any refresh. The render-time filter hides a book by its
        // isPrivate flag, so anything that fails or merely takes a while in
        // between would leave a newly private title classified as ordinary —
        // and still on screen after the next lock.
        setBooks((current) =>
          current.map((entry) =>
            entry.id === book.id
              ? { ...entry, isPrivate, wrappedKey: rewrapped }
              : entry,
          ),
        );
        await updateLocalWrappedKey(book.id, rewrapped);
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not move that book.");
        return false;
      }
    },
    [refresh],
  );

  /**
   * Takes a book off the shelf without destroying a word of it.
   *
   * `refresh` already filters on `archived_at is null`, so stamping the column
   * is the whole operation — the row, its update log, and the local snapshot
   * all stay exactly where they are. Nothing here is a one-way door: clearing
   * the column puts the book back, whenever there is a screen that does it.
   */
  const setArchived = useCallback(
    async (bookId: string, archived: boolean) => {
      const { error: err } = await supabase
        .from("books")
        .update({ archived_at: archived ? new Date().toISOString() : null })
        .eq("id", bookId);
      if (err) {
        setError(err.message);
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  /**
   * Filtered during render, not in state.
   *
   * lockPrivate() announces synchronously, but an effect that pruned state
   * would only run *after* the render it triggered — leaving one painted frame
   * with private titles on screen after the lock. Deriving it here means there
   * is no such frame to have: a private row while locked is not a state this
   * can be in.
   *
   * The effect below still prunes, for a different reason — to get decrypted
   * titles out of memory rather than merely off the screen.
   */
  const visible = privateUnlocked
    ? books
    : books.filter((book) => !book.isPrivate);

  return {
    books: visible,
    loading,
    error,
    refresh,
    createBook,
    setArchived,
    setPrivate,
  };
}

/**
 * A title that will not decrypt under its own book's key is damaged rather than
 * hidden — the key already proved itself by unwrapping. Showing the book as
 * untitled keeps it reachable, which matters more than the label: the prose
 * inside is sealed separately and is very likely fine.
 */
async function readTitle(key: CryptoKey, cipher: string): Promise<string> {
  try {
    return await unsealText(key, cipher);
  } catch (err) {
    console.warn("Could not read a book title", err);
    return "Untitled";
  }
}
