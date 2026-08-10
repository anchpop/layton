import { useEffect, useState } from "react";
import type { LoroDoc } from "loro-crdt";

import { BookSync, type SyncState } from "../lib/sync";
import { subscribe as subscribeVault } from "../lib/vault";
import {
  chapterList,
  getTitle,
  metaMap,
  readChapters,
  type ChapterIndexEntry,
} from "../lib/book";

/** Creates and owns the sync engine for one book. */
export function useBookSync(bookId: string | null, ownerId: string | null) {
  const [sync, setSync] = useState<BookSync | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!bookId || !ownerId) {
      setSync(null);
      return;
    }
    const engine = new BookSync(bookId, ownerId);
    setSync(engine);
    void engine.start();
    return () => {
      engine.destroy();
      setSync(null);
    };
  }, [bookId, ownerId, generation]);

  /**
   * Rebuild the engine when the private key comes or goes.
   *
   * Rebuilding rather than patching the running one is the point: locking has
   * to take the prose out of memory, and a LoroDoc that has already imported a
   * chapter cannot be emptied. A fresh engine brings a fresh document, so the
   * only way back to the words is through the key.
   *
   * Ordinary books sit this out. They are unaffected by the private key either
   * way, and tearing one down would cost the writer their caret and their place
   * on the page for nothing.
   */
  useEffect(() => {
    if (!sync) return;
    let affected = false;
    let settled = false;
    let wasOpen = false;
    const stopWatchingBook = sync.subscribe((state) => {
      affected = state.status === "locked" || state.isPrivate;
      const open =
        state.status !== "loading" &&
        state.status !== "locked" &&
        state.status !== "unavailable";
      if (open) wasOpen = true;
      // An engine that was open and has gone locked had its key taken away
      // underneath it — the book was made private on another device. Hiding
      // the page is not enough there: the LoroDoc still holds the chapters, and
      // only a fresh engine brings a fresh document. A rebuilt engine goes
      // straight from loading to locked without ever being open, so this cannot
      // chase its own tail.
      else if (wasOpen && state.status === "locked") {
        wasOpen = false;
        setGeneration((g) => g + 1);
      }
    });
    const stopWatchingVault = subscribeVault(() => {
      if (!settled) {
        settled = true; // the immediate call on subscribe is not a change
        return;
      }
      if (affected) setGeneration((g) => g + 1);
    });
    return () => {
      stopWatchingBook();
      stopWatchingVault();
    };
  }, [sync]);

  return sync;
}

export function useSyncState(sync: BookSync | null): SyncState {
  const [state, setState] = useState<SyncState>({
    status: "loading",
    pending: 0,
    isPrivate: false,
    error: null,
  });
  useEffect(() => {
    if (!sync) return;
    return sync.subscribe(setState);
  }, [sync]);
  return state;
}

/**
 * Chapter index, re-read only when the index subtree actually changes.
 *
 * This subscribes to the `chapters` container rather than the document, which
 * is why typing in a chapter does not re-render the sidebar — the prose lives
 * in a sibling subtree (see lib/book.ts).
 */
export function useChapters(doc: LoroDoc | null): ChapterIndexEntry[] {
  const [chapters, setChapters] = useState<ChapterIndexEntry[]>([]);

  useEffect(() => {
    if (!doc) {
      setChapters([]);
      return;
    }
    // Read once up front: the cached snapshot may have been imported before
    // this effect ran, in which case no event is coming for it.
    setChapters(readChapters(doc));
    return chapterList(doc).subscribe(() => setChapters(readChapters(doc)));
  }, [doc]);

  return chapters;
}

/** Book title, kept live against the `meta` subtree. */
export function useBookTitle(doc: LoroDoc | null): string {
  const [title, setTitle] = useState(() => (doc ? getTitle(doc) : "Untitled"));

  useEffect(() => {
    if (!doc) return;
    setTitle(getTitle(doc));
    return metaMap(doc).subscribe(() => setTitle(getTitle(doc)));
  }, [doc]);

  return title;
}
