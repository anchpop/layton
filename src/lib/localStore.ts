import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * Local durability. Two responsibilities:
 *
 *  1. A cached Loro snapshot per book, so opening offline (or on a cold load)
 *     is instant and works with no network at all.
 *  2. An outbox of local updates that have not yet reached Postgres. This is
 *     what makes an offline edit survive a browser restart: the update is
 *     durable here before we ever try to send it.
 *
 * `watermark` is the highest book_updates.id already folded into the cached
 * snapshot, so a reconnect only has to fetch what it genuinely missed.
 */

type BookLocal = {
  bookId: string;
  snapshot: Uint8Array;
  watermark: number;
  title: string;
  savedAt: number;
};

type OutboxEntry = {
  seq?: number;
  bookId: string;
  payload: string; // base64 Loro update
  createdAt: number;
};

interface LaytonDB extends DBSchema {
  books: {
    key: string;
    value: BookLocal;
  };
  outbox: {
    key: number;
    value: OutboxEntry;
    indexes: { byBook: string };
  };
}

let dbPromise: Promise<IDBPDatabase<LaytonDB>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<LaytonDB>("layton", 1, {
      upgrade(database) {
        database.createObjectStore("books", { keyPath: "bookId" });
        const outbox = database.createObjectStore("outbox", {
          keyPath: "seq",
          autoIncrement: true,
        });
        outbox.createIndex("byBook", "bookId");
      },
    });
  }
  return dbPromise;
}

export async function loadLocalBook(bookId: string): Promise<BookLocal | null> {
  return (await (await db()).get("books", bookId)) ?? null;
}

export async function saveLocalBook(entry: {
  bookId: string;
  snapshot: Uint8Array;
  watermark: number;
  title: string;
}): Promise<void> {
  await (await db()).put("books", { ...entry, savedAt: Date.now() });
}

export async function deleteLocalBook(bookId: string): Promise<void> {
  const database = await db();
  await database.delete("books", bookId);
  const tx = database.transaction("outbox", "readwrite");
  const index = tx.store.index("byBook");
  for await (const cursor of index.iterate(bookId)) await cursor.delete();
  await tx.done;
}

export async function enqueueOutbox(
  bookId: string,
  payload: string,
): Promise<void> {
  await (await db()).add("outbox", { bookId, payload, createdAt: Date.now() });
}

export async function readOutbox(bookId: string): Promise<OutboxEntry[]> {
  const entries = await (await db()).getAllFromIndex("outbox", "byBook", bookId);
  return entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function clearOutboxEntries(seqs: number[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("outbox", "readwrite");
  await Promise.all(seqs.map((seq) => tx.store.delete(seq)));
  await tx.done;
}

export async function outboxCount(bookId: string): Promise<number> {
  return (await readOutbox(bookId)).length;
}

export type { BookLocal, OutboxEntry };
