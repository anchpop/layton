import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * Local durability. Four responsibilities:
 *
 *  1. A cached Loro snapshot per book, so opening offline (or on a cold load)
 *     is instant and works with no network at all.
 *  2. An outbox of local updates that have not yet reached Postgres. This is
 *     what makes an offline edit survive a browser restart: the update is
 *     durable here before we ever try to send it.
 *  3. The everyday content key for this device, so ordinary books open without
 *     a password prompt every session.
 *  4. A copy of the account's sealed key record, so unlocking works on a plane.
 *
 * `watermark` is the highest book_updates.id already folded into the cached
 * snapshot, so a reconnect only has to fetch what it genuinely missed.
 *
 * Nothing readable is stored here
 * -------------------------------
 * Every field that ever held prose now holds a sealed envelope, and the field
 * names say so. That is not belt-and-braces: signing out forgets the device key
 * while leaving these rows in place, so IndexedDB is routinely expected to hold
 * data this browser can no longer read. It also means a private book leaves no
 * distinguishable trace locally — a row whose `wrappedKey` will not open is
 * indistinguishable from one that failed for any other reason.
 *
 * The device key itself is stored as a non-extractable CryptoKey. Structured
 * clone keeps it usable across restarts while its raw bytes stay unreadable to
 * script — including to a script that should not be running.
 */

type BookLocal = {
  bookId: string;
  /**
   * The book's own key, sealed under one of the two account keys. Which one is
   * not recorded — trying to open it is how the client learns whether this is a
   * private book, and failing to open it is how a private book stays hidden.
   */
  wrappedKey: string;
  /** Sealed under the book's key. */
  sealedSnapshot: Uint8Array;
  watermark: number;
  savedAt: number;
};

type OutboxEntry = {
  seq?: number;
  bookId: string;
  /** Base64 of a sealed Loro update — already ciphertext, sent to Postgres verbatim. */
  payload: string;
  createdAt: number;
};

type DeviceKeyEntry = {
  userId: string;
  key: CryptoKey;
};

type VaultRecord = {
  userId: string;
  salt: string;
  iterations: number;
  wrappedKey: string;
  wrappedPrivateKey: string;
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
  deviceKeys: {
    key: string;
    value: DeviceKeyEntry;
  };
  vaults: {
    key: string;
    value: VaultRecord;
  };
}

const DB_NAME = "layton";
/**
 * v2 introduced encryption. The v1 stores held plaintext snapshots and unsealed
 * outbox payloads, which the new code would read as sealed envelopes and reject
 * one at a time. They are cleared on upgrade instead: there is no key that can
 * decrypt them, because none existed when they were written.
 */
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<LaytonDB>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<LaytonDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          database.createObjectStore("books", { keyPath: "bookId" });
          const outbox = database.createObjectStore("outbox", {
            keyPath: "seq",
            autoIncrement: true,
          });
          outbox.createIndex("byBook", "bookId");
        } else if (oldVersion < 2) {
          // Scoped to the v1→v2 step deliberately. These stores held plaintext
          // then and hold sealed envelopes now, so they had to go once. A later
          // version bump must not inherit a clause that silently destroys
          // every cached book and every unsent edit on the way past.
          void tx.objectStore("books").clear();
          void tx.objectStore("outbox").clear();
        }
        if (oldVersion < 2) {
          database.createObjectStore("deviceKeys", { keyPath: "userId" });
          database.createObjectStore("vaults", { keyPath: "userId" });
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Books and the outbox
// ---------------------------------------------------------------------------

export async function loadLocalBook(bookId: string): Promise<BookLocal | null> {
  return (await (await db()).get("books", bookId)) ?? null;
}

export async function saveLocalBook(entry: {
  bookId: string;
  wrappedKey: string;
  sealedSnapshot: Uint8Array;
  watermark: number;
}): Promise<void> {
  await (await db()).put("books", { ...entry, savedAt: Date.now() });
}

/**
 * Follow a book's key from one account key to the other after it is made
 * private (or ordinary again). Only the wrapping changes — the book's own key,
 * and therefore every envelope already written under it, is untouched.
 */
export async function updateLocalWrappedKey(
  bookId: string,
  wrappedKey: string,
): Promise<void> {
  const database = await db();
  const existing = await database.get("books", bookId);
  if (!existing) return;
  await database.put("books", { ...existing, wrappedKey });
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

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export async function loadDeviceKey(userId: string): Promise<CryptoKey | null> {
  return (await (await db()).get("deviceKeys", userId))?.key ?? null;
}

export async function saveDeviceKey(
  userId: string,
  key: CryptoKey,
): Promise<void> {
  await (await db()).put("deviceKeys", { userId, key });
}

export async function forgetDeviceKey(userId: string): Promise<void> {
  await (await db()).delete("deviceKeys", userId);
}

export async function loadVaultRecord(
  userId: string,
): Promise<VaultRecord | null> {
  return (await (await db()).get("vaults", userId)) ?? null;
}

export async function saveVaultRecord(record: VaultRecord): Promise<void> {
  await (await db()).put("vaults", record);
}

/**
 * Forget one book entirely, cached snapshot and unsent edits together.
 *
 * Deliberately per-book rather than a clear-the-store helper. A local record
 * carries no account id — books are keyed by book id alone — so a wholesale
 * wipe on behalf of one account would take another account's unsynced offline
 * edits with it, and those exist nowhere else.
 */
export async function deleteLocalBook(bookId: string): Promise<void> {
  const database = await db();
  await database.delete("books", bookId);
  const tx = database.transaction("outbox", "readwrite");
  const index = tx.store.index("byBook");
  for await (const cursor of index.iterate(bookId)) await cursor.delete();
  await tx.done;
}

export async function forgetVaultRecord(userId: string): Promise<void> {
  await (await db()).delete("vaults", userId);
}

export type { BookLocal, OutboxEntry, VaultRecord };
