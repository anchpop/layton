import { useEffect, useState } from "react";
import type { LoroDoc } from "loro-crdt";

import { BookSync, type SyncState } from "../lib/sync";
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
  }, [bookId, ownerId]);

  return sync;
}

export function useSyncState(sync: BookSync | null): SyncState {
  const [state, setState] = useState<SyncState>({
    status: "loading",
    pending: 0,
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
