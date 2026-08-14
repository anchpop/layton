import { LoroDoc } from "loro-crdt";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase, type BookUpdateRow } from "./supabase";
import { base64ToBytes, bytesToBase64 } from "./bytes";
import { seal, sealText, unseal } from "./crypto";
import { moveBookPrivacy, openBookKey } from "./vault";
import { getTitle } from "./book";
import {
  listShares,
  publishShare,
  revokeShare,
  updateShare,
  type ShareLink,
} from "./sharePublish";
import {
  clearOutboxEntries,
  enqueueOutbox,
  loadLocalBook,
  readOutbox,
  saveLocalBook,
  updateLocalWrappedKey,
  type BookLocal,
} from "./localStore";

export type SyncState = {
  /** What the status pill shows. */
  status:
    | "loading"
    /** A key exists for this book; this browser is not holding it. */
    | "locked"
    /** No wrapper could be found at all — deleted, or never cached offline. */
    | "unavailable"
    | "offline"
    | "syncing"
    | "synced"
    | "error";
  /** Local edits not yet acknowledged by Postgres. */
  pending: number;
  /** True once this book is known to be a private one. */
  isPrivate: boolean;
  error: string | null;
};

type Listener = (state: SyncState) => void;

/** Rows fetched per catch-up page. */
const PAGE = 500;
/** Compact once the log grows past this many rows. */
const COMPACT_THRESHOLD = 150;
/** Debounce for writing the local snapshot cache. */
const SNAPSHOT_DEBOUNCE_MS = 1500;
/** Debounce for pushing queued updates to Postgres. */
const FLUSH_DEBOUNCE_MS = 250;

/**
 * Keeps one book's Loro document in step with Postgres.
 *
 * Ordering model
 * --------------
 * `watermark` is the highest book_updates.id that has been applied *through an
 * ordered fetch*. Realtime payloads are applied immediately as a latency
 * optimisation but never advance the watermark, because realtime delivery has
 * no ordering or completeness guarantee. Every realtime event also schedules a
 * catch-up fetch (`id > watermark`, ordered), and only that path moves the
 * watermark. Loro imports are idempotent, so applying a payload twice is free
 * and the fast path costs nothing in correctness.
 *
 * This is what makes a dropped realtime message self-healing rather than a
 * permanently missing edit.
 *
 * Encryption model
 * ----------------
 * Nothing leaves this class in the clear. Every payload written to Postgres and
 * every snapshot written to IndexedDB is sealed under this book's own key
 * first, and that key is obtained by unwrapping `wrapped_key` with whichever
 * account key this browser is holding (see lib/vault.ts).
 *
 * When neither account key opens it, the engine stops at `locked` rather than
 * failing: that is the normal state of a private book whose key has been put
 * away, and the document is left empty so no prose ever reaches memory.
 */
export class BookSync {
  readonly doc = new LoroDoc();
  readonly bookId: string;

  private watermark = 0;
  private ownerId: string;
  private channel: RealtimeChannel | null = null;
  private listeners = new Set<Listener>();
  private state: SyncState = {
    status: "loading",
    pending: 0,
    isPrivate: false,
    error: null,
  };

  /** This book's content key. Absent until start() unwraps it. */
  private key: CryptoKey | null = null;
  /** The sealed form, carried so the local cache can be rewritten with it. */
  private wrappedKey: string | null = null;

  private unsubscribeLocal: (() => void) | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUpQueued = false;
  private catchUpRunning = false;
  private flushing = false;
  private flushQueued = false;
  /** Set when this book's wrapping changed to one no key here can open. */
  private revoked = false;
  private destroyed = false;
  /**
   * Set when a row came back that could not be applied. Everything stops:
   * the watermark stays put, no snapshot claims the row was absorbed, and
   * compaction — which deletes rows at or below the watermark — is refused.
   *
   * The alternative is worse than an error message. Advancing past a row we
   * failed to read would have this client report "synced", cache a snapshot
   * that silently omits an edit, and then hand the server a watermark
   * authorising it to delete the only copy of that edit.
   */
  private stalled = false;
  /**
   * Serialises the sealing and queueing of local updates.
   *
   * subscribeLocalUpdates fires synchronously, but everything the handler does
   * — encrypt, then write to IndexedDB — is asynchronous, so two updates a few
   * milliseconds apart would otherwise race for their autoincrement outbox
   * sequence and could be queued in the wrong order. Loro tolerates that, but
   * only because it buffers updates whose dependencies have not arrived; it
   * costs nothing to hand them over in the order they were made.
   */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Set once the cached snapshot has been loaded. Guards persistSnapshot from
   * writing an empty document over a good cache — which matters because React
   * StrictMode mounts, unmounts and remounts this engine, and the unmount can
   * land before the initial load resolves.
   */
  private loaded = false;

  constructor(bookId: string, ownerId: string) {
    this.bookId = bookId;
    this.ownerId = ownerId;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<SyncState>) {
    // Two states this engine does not come back from, and both have to survive
    // whatever was already in flight when they happened. A catch-up or a
    // SUBSCRIBED callback landing a moment later would otherwise report synced
    // — putting a revoked book's document back on screen, or claiming success
    // for a log this client has stopped being able to read.
    const terminal =
      this.revoked ? ("locked" as const)
      : this.stalled ? ("error" as const)
      : null;
    const next = terminal && patch.status ? { ...patch, status: terminal } : patch;
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l(this.state);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const local = await loadLocalBook(this.bookId);

    // 0. Nothing can be read or written without this book's key.
    const resolved = await this.resolveKey(local);
    if (resolved !== "open") {
      if (!this.destroyed) this.setState({ status: resolved, pending: 0 });
      return;
    }

    // 1. Local first: the document is usable before any network call resolves.
    if (local) {
      try {
        this.doc.import(await unseal(this.key!, local.sealedSnapshot));
        this.watermark = local.watermark;
      } catch (err) {
        console.warn("Discarding unreadable local snapshot", err);
      }
    }
    // 2. Replay whatever a previous session queued but never sent.
    //
    //    These are emphatically *not* guaranteed to be in the snapshot above.
    //    The outbox write is immediate and the snapshot is debounced by a
    //    second and a half, so a tab closed in that window leaves durable
    //    updates that the cached snapshot predates. Importing only the snapshot
    //    would open the book missing its most recent sentences — and offline,
    //    with no round trip to restore them, it would look exactly like losing
    //    them. Loro imports are idempotent, so replaying costs nothing in the
    //    ordinary case where the snapshot did get written.
    const queued = await readOutbox(this.bookId);
    for (const entry of queued) {
      try {
        this.doc.import(await unseal(this.key!, base64ToBytes(entry.payload)));
      } catch (err) {
        console.warn("Could not replay a queued edit", err);
      }
    }

    this.loaded = true;

    if (this.destroyed) return;

    this.setState({
      pending: queued.length,
      status: queued.length > 0 ? "syncing" : "synced",
    });

    // 3. Start capturing local edits *before* the first fetch, so an edit made
    //    while catching up is never dropped.
    this.unsubscribeLocal = this.doc.subscribeLocalUpdates((bytes) => {
      this.tail = this.tail
        .then(() => this.onLocalUpdate(bytes))
        .catch((err) => console.warn("Failed to queue a local edit", err));
    });

    this.connectRealtime();
    void this.catchUp();
    void this.flush();

    window.addEventListener("online", this.handleOnline);
    document.addEventListener("visibilitychange", this.handleVisibility);
  }

  /**
   * Find the key that opens this book.
   *
   * The server is asked first, and that order is the whole point. Making a book
   * private changes only its wrapping, which leaves the *old* wrapping
   * cryptographically valid forever — so a device still holding the cached
   * everyday-key copy would go on opening a book that is no longer meant to be
   * visible to it, and would never learn otherwise because nothing failed.
   * Preferring the cached wrapper is only safe when there is no server to ask.
   *
   * Offline, that device keeps whatever access it last had. This is the one
   * case the design cannot close: a wrapper it already holds cannot be taken
   * away without something to take it away. The window ends at the next open
   * with a connection.
   */
  private async resolveKey(
    local: BookLocal | null,
  ): Promise<"open" | "locked" | "unavailable"> {
    const wrapped = (await this.fetchWrappedKey()) ?? local?.wrappedKey ?? null;
    // No wrapper anywhere is a different fact from a wrapper that will not
    // open, and the difference is what the screen says next. Offering a
    // password prompt for a book that has been deleted — or for one this device
    // has simply never seen and cannot reach — is an instruction that cannot
    // work, however politely it is phrased.
    if (!wrapped) return "unavailable";

    const opened = await openBookKey(wrapped);
    if (!opened) return "locked";

    this.key = opened.key;
    this.wrappedKey = wrapped;
    this.setState({ isPrivate: opened.isPrivate });
    return "open";
  }

  private async fetchWrappedKey(): Promise<string | null> {
    // Skip the request rather than wait out its timeout: an offline open should
    // reach the writing at cached-snapshot speed.
    if (!navigator.onLine) return null;
    try {
      const { data } = await supabase
        .from("books")
        .select("wrapped_key")
        .eq("id", this.bookId)
        .maybeSingle();
      return (data?.wrapped_key as string | undefined) ?? null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.listeners.clear();
    window.removeEventListener("online", this.handleOnline);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    // Runs on the tail so a snapshot cannot be written before an edit that
    // preceded it has been sealed into the outbox.
    this.tail = this.tail.then(() => this.persistSnapshot());
  }

  private handleOnline = () => {
    void this.recheckWrapper();
    this.scheduleCatchUp();
    void this.flush();
  };

  private handleVisibility = () => {
    if (document.visibilityState !== "visible") return;
    void this.recheckWrapper();
    this.scheduleCatchUp();
  };

  /**
   * Notice that this book's wrapping moved while the tab sat open.
   *
   * Making a book private elsewhere changes only the wrapper, and the old one
   * stays valid — so nothing fails, no error arrives, and a tab that already
   * holds the everyday-key copy would otherwise go on displaying a book that is
   * no longer meant to be visible to it for as long as it stays open.
   *
   * Checked when the tab is returned to and when the network comes back rather
   * than on every catch-up: those are the moments a person is coming back to
   * the screen, and they cost one small query instead of one per keystroke
   * arriving from a peer. A tab left open and untouched keeps its key, which is
   * the same thing as saying a key cannot be taken back out of a running
   * process — only that the window closes the moment anyone looks at it.
   */
  private async recheckWrapper(): Promise<void> {
    if (this.destroyed || !this.wrappedKey) return;
    const fresh = await this.fetchWrappedKey();
    if (!fresh || fresh === this.wrappedKey || this.destroyed) return;

    const opened = await openBookKey(fresh);

    // Queued behind the tail, and the wrapper is written down either way.
    //
    // The tail, because an edit part-way through sealing needs the old key to
    // reach the outbox; pulling it out from under that handler would discard
    // the words. And written down even when it cannot be opened, because this
    // device has now *seen* the transition — leaving the old wrapper cached
    // would let the next offline open walk straight back into the book it just
    // lost access to.
    this.tail = this.tail
      .then(async () => {
        await updateLocalWrappedKey(this.bookId, fresh);
        if (!opened) {
          this.key = null;
          this.wrappedKey = null;
          this.revoked = true;
          this.setState({ status: "locked" });
          return;
        }
        this.key = opened.key;
        this.wrappedKey = fresh;
        this.setState({ isPrivate: opened.isPrivate });
      })
      .catch((err) => console.warn("Could not follow this book's key", err));
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private async onLocalUpdate(bytes: Uint8Array) {
    if (!this.key) return;
    // Sealed before it is stored, stored before it is sent: an offline edit
    // must survive a reload, and must be ciphertext the moment it does.
    const payload = bytesToBase64(await seal(this.key, bytes));
    await enqueueOutbox(this.bookId, payload);
    this.setState({ pending: this.state.pending + 1, status: "syncing" });
    this.scheduleSnapshot();
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DEBOUNCE_MS);
  }

  /**
   * Send the outbox, and keep sending until it is empty.
   *
   * The loop is the point. An edit made while an insert was in flight is not
   * covered by that insert — clearOutboxEntries only removes the sequences it
   * sent — so a single pass would leave it queued while the badge said
   * "synced", which is the one thing the badge must never say wrongly. The
   * trailing re-entry covers the same race one step later, between the outbox
   * reading empty and this releasing the lock.
   */
  private async flush(): Promise<void> {
    if (this.destroyed || !this.key) return;
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.flushing = true;
    try {
      for (;;) {
        if (this.destroyed) return;
        const queued = await readOutbox(this.bookId);
        if (queued.length === 0) {
          this.setState({ pending: 0 });
          if (this.state.status !== "offline") {
            this.setState({ status: "synced", error: null });
          }
          return;
        }

        this.setState({ pending: queued.length, status: "syncing" });

        // Already sealed on the way into the outbox — sent on verbatim.
        const { error } = await supabase.from("book_updates").insert(
          queued.map((entry) => ({
            book_id: this.bookId,
            owner_id: this.ownerId,
            kind: "update" as const,
            payload: entry.payload,
          })),
        );

        if (error) {
          // Stay queued and try again on the next trigger. This is the normal
          // path when offline, so it is not surfaced as a hard error.
          this.setState({
            status: navigator.onLine ? "error" : "offline",
            error: navigator.onLine ? error.message : null,
          });
          return;
        }

        await clearOutboxEntries(
          queued.map((e) => e.seq).filter((s): s is number => s != null),
        );
        this.scheduleCatchUp();
      }
    } finally {
      this.flushing = false;
      if (this.flushQueued) {
        this.flushQueued = false;
        void this.flush();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private connectRealtime() {
    this.channel = supabase
      .channel(`book:${this.bookId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "book_updates",
          filter: `book_id=eq.${this.bookId}`,
        },
        (message) => {
          const row = message.new as BookUpdateRow;
          // Fast path: apply straight away for low-latency collaboration.
          if (row.id > this.watermark && typeof row.payload === "string") {
            void this.applyPayload(row.payload);
          }
          // Authoritative path: an ordered fetch is what moves the watermark.
          this.scheduleCatchUp();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.setState({
            status: this.state.pending > 0 ? "syncing" : "synced",
            error: null,
          });
          this.scheduleCatchUp();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.setState({ status: navigator.onLine ? "error" : "offline" });
        }
      });
  }

  private async applyPayload(payload: string): Promise<boolean> {
    if (!this.key) return false;
    try {
      this.doc.import(await unseal(this.key, base64ToBytes(payload)));
      this.scheduleSnapshot();
      return true;
    } catch (err) {
      console.warn("Failed to import remote update", err);
      return false;
    }
  }

  private scheduleCatchUp() {
    if (this.catchUpRunning) {
      this.catchUpQueued = true;
      return;
    }
    void this.catchUp();
  }

  private async catchUp(): Promise<void> {
    if (this.destroyed || this.catchUpRunning || !this.key || this.stalled) {
      return;
    }
    this.catchUpRunning = true;
    try {
      do {
        this.catchUpQueued = false;
        let done = false;
        while (!done && !this.destroyed) {
          const { data, error } = await supabase
            .from("book_updates")
            .select("id,payload,kind")
            .eq("book_id", this.bookId)
            .gt("id", this.watermark)
            .order("id", { ascending: true })
            .limit(PAGE);

          if (error) {
            this.setState({
              status: navigator.onLine ? "error" : "offline",
              error: navigator.onLine ? error.message : null,
            });
            return;
          }

          const rows = (data ?? []) as Pick<
            BookUpdateRow,
            "id" | "payload" | "kind"
          >[];
          for (const row of rows) {
            if (!(await this.applyPayload(row.payload))) {
              this.stalled = true;
              this.setState({
                status: "error",
                error:
                  "An update in this book could not be read. Nothing has been discarded.",
              });
              return;
            }
            this.watermark = Math.max(this.watermark, row.id);
          }
          done = rows.length < PAGE;
        }

        if (!this.destroyed) {
          this.setState({
            status: this.state.pending > 0 ? "syncing" : "synced",
            error: null,
          });
          this.scheduleSnapshot();
        }
      } while (this.catchUpQueued && !this.destroyed);
    } finally {
      this.catchUpRunning = false;
    }
    void this.maybeCompact();
  }

  // -------------------------------------------------------------------------
  // Persistence & compaction
  // -------------------------------------------------------------------------

  /**
   * Queued behind the same tail as sealing, not fired independently.
   *
   * A timer that ran on its own could land between a local edit reaching the
   * document and that edit reaching the outbox. The cached snapshot would then
   * contain an operation with no queued update to send, and a crash in that
   * window would restore the words locally while no peer ever receives them —
   * the one failure this whole outbox exists to prevent.
   */
  private scheduleSnapshot() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.tail = this.tail
        .then(() => this.persistSnapshot())
        .catch((err) => console.warn("Failed to cache book locally", err));
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * The watermark is read in the same breath as the export, before any await.
   *
   * Sealing is asynchronous, and a catch-up can import rows while it runs. Read
   * afterwards, the watermark would describe a document newer than the snapshot
   * it is stored beside — and the next open, trusting it, would fetch only rows
   * above a line those updates fall below. They would simply never be applied.
   */
  private async persistSnapshot(): Promise<void> {
    if (!this.loaded || !this.key || !this.wrappedKey) return;
    const watermark = this.watermark;
    const snapshot = this.doc.export({ mode: "snapshot" });
    try {
      await saveLocalBook({
        bookId: this.bookId,
        wrappedKey: this.wrappedKey,
        sealedSnapshot: await seal(this.key, snapshot),
        watermark,
      });
    } catch (err) {
      console.warn("Failed to cache book locally", err);
    }
  }

  /**
   * Collapse the server-side log once it gets long. Safe by construction: the
   * server only deletes rows at or below the watermark we pass, and the
   * watermark is exactly what this document has already absorbed.
   */
  private async maybeCompact(): Promise<void> {
    if (this.destroyed || this.watermark === 0 || !this.key || this.stalled) {
      return;
    }
    try {
      const { count, error } = await supabase
        .from("book_updates")
        .select("id", { count: "exact", head: true })
        .eq("book_id", this.bookId);

      if (error || (count ?? 0) < COMPACT_THRESHOLD) return;

      // Paired before any await, and here it matters more than anywhere else:
      // p_upto authorises the server to delete rows, and a watermark read after
      // sealing could name rows this snapshot does not contain. That is not a
      // stale cache — it is the only copy of an edit, deleted.
      const upto = this.watermark;
      const snapshot = bytesToBase64(
        await seal(this.key, this.doc.export({ mode: "snapshot" })),
      );
      await supabase.rpc("compact_book", {
        p_book_id: this.bookId,
        p_upto: upto,
        p_snapshot: snapshot,
      });
      this.scheduleCatchUp();
    } catch (err) {
      console.warn("Compaction skipped", err);
    }
  }

  /**
   * Make this book private, or ordinary again, from inside the book itself.
   *
   * The engine is where this belongs: it already holds the wrapper and already
   * owns keeping it current, so the sidebar does not have to fetch a row it
   * isn't otherwise reading just to change one column of it.
   */
  async setPrivate(isPrivate: boolean): Promise<void> {
    if (!this.wrappedKey) throw new Error("This book is not open.");
    this.wrappedKey = await moveBookPrivacy(
      this.bookId,
      this.wrappedKey,
      isPrivate,
    );
    this.setState({ isPrivate });
  }

  /**
   * Sharing lives on the engine for the same reason setPrivate does: it needs
   * the open document and the book's key together, and this is the only place
   * that holds both. The mechanics are in lib/sharePublish.ts.
   */
  async shareCopy(): Promise<ShareLink> {
    if (!this.key) throw new Error("This book is not open.");
    return publishShare(this.doc, this.bookId, this.ownerId, this.key);
  }

  /** Push today's story to an existing link; the link itself never changes. */
  async updateShareLink(id: string): Promise<string> {
    if (!this.key) throw new Error("This book is not open.");
    return updateShare(this.doc, id, this.key);
  }

  async listShareLinks(): Promise<ShareLink[]> {
    if (!this.key) throw new Error("This book is not open.");
    return listShares(this.bookId, this.key);
  }

  async revokeShareLink(id: string): Promise<void> {
    return revokeShare(id);
  }

  /** Mirror the in-document title onto the books row that the library lists. */
  async syncTitleToLibrary(): Promise<void> {
    if (!this.key) return;
    const title_cipher = await sealText(this.key, getTitle(this.doc));
    await supabase.from("books").update({ title_cipher }).eq("id", this.bookId);
  }
}
