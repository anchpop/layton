import { LoroDoc } from "loro-crdt";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase, type BookUpdateRow } from "./supabase";
import { base64ToBytes, bytesToBase64 } from "./bytes";
import { getTitle } from "./book";
import {
  clearOutboxEntries,
  enqueueOutbox,
  loadLocalBook,
  readOutbox,
  saveLocalBook,
} from "./localStore";

export type SyncState = {
  /** What the status pill shows. */
  status: "loading" | "offline" | "syncing" | "synced" | "error";
  /** Local edits not yet acknowledged by Postgres. */
  pending: number;
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
 */
export class BookSync {
  readonly doc = new LoroDoc();
  readonly bookId: string;

  private watermark = 0;
  private ownerId: string;
  private channel: RealtimeChannel | null = null;
  private listeners = new Set<Listener>();
  private state: SyncState = { status: "loading", pending: 0, error: null };

  private unsubscribeLocal: (() => void) | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUpQueued = false;
  private catchUpRunning = false;
  private flushing = false;
  private destroyed = false;
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
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    // 1. Local first: the document is usable before any network call resolves.
    const local = await loadLocalBook(this.bookId);
    if (local) {
      try {
        this.doc.import(local.snapshot);
        this.watermark = local.watermark;
      } catch (err) {
        console.warn("Discarding unreadable local snapshot", err);
      }
    }
    this.loaded = true;

    if (this.destroyed) return;

    // 2. Surface anything a previous session queued but never sent. Those
    //    updates are already inside the cached snapshot, so flush() only has to
    //    re-send them — never re-apply them.
    const queued = await readOutbox(this.bookId);
    this.setState({
      pending: queued.length,
      status: queued.length > 0 ? "syncing" : "synced",
    });

    // 3. Start capturing local edits *before* the first fetch, so an edit made
    //    while catching up is never dropped.
    this.unsubscribeLocal = this.doc.subscribeLocalUpdates((bytes) => {
      void this.onLocalUpdate(bytes);
    });

    this.connectRealtime();
    void this.catchUp();
    void this.flush();

    window.addEventListener("online", this.handleOnline);
    document.addEventListener("visibilitychange", this.handleVisibility);
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
    void this.persistSnapshot();
  }

  private handleOnline = () => {
    this.scheduleCatchUp();
    void this.flush();
  };

  private handleVisibility = () => {
    if (document.visibilityState === "visible") this.scheduleCatchUp();
  };

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private async onLocalUpdate(bytes: Uint8Array) {
    // Durable before it is sendable: an offline edit must survive a reload.
    await enqueueOutbox(this.bookId, bytesToBase64(bytes));
    this.setState({ pending: this.state.pending + 1, status: "syncing" });
    this.scheduleSnapshot();
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.destroyed) return;
    this.flushing = true;
    try {
      const queued = await readOutbox(this.bookId);
      if (queued.length === 0) {
        this.setState({ pending: 0 });
        if (this.state.status !== "offline") {
          this.setState({ status: "synced", error: null });
        }
        return;
      }

      this.setState({ pending: queued.length, status: "syncing" });

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
      this.setState({ pending: 0, status: "synced", error: null });
      this.scheduleCatchUp();
    } finally {
      this.flushing = false;
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
            this.applyPayload(row.payload);
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

  private applyPayload(payload: string): boolean {
    try {
      this.doc.import(base64ToBytes(payload));
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
    if (this.destroyed || this.catchUpRunning) return;
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
            this.applyPayload(row.payload);
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

  private scheduleSnapshot() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(
      () => void this.persistSnapshot(),
      SNAPSHOT_DEBOUNCE_MS,
    );
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.loaded) return;
    try {
      await saveLocalBook({
        bookId: this.bookId,
        snapshot: this.doc.export({ mode: "snapshot" }),
        watermark: this.watermark,
        title: getTitle(this.doc),
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
    if (this.destroyed || this.watermark === 0) return;
    try {
      const { count, error } = await supabase
        .from("book_updates")
        .select("id", { count: "exact", head: true })
        .eq("book_id", this.bookId);

      if (error || (count ?? 0) < COMPACT_THRESHOLD) return;

      const snapshot = bytesToBase64(this.doc.export({ mode: "snapshot" }));
      await supabase.rpc("compact_book", {
        p_book_id: this.bookId,
        p_upto: this.watermark,
        p_snapshot: snapshot,
      });
      this.scheduleCatchUp();
    } catch (err) {
      console.warn("Compaction skipped", err);
    }
  }

  /** Mirror the in-document title onto the books row that the library lists. */
  async syncTitleToLibrary(): Promise<void> {
    const title = getTitle(this.doc);
    await supabase.from("books").update({ title }).eq("id", this.bookId);
  }
}
