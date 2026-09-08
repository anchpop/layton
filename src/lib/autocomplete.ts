import { TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type { LoroDoc } from "loro-crdt";
import { toast } from "sonner";

import { supabase } from "./supabase";
import { schema } from "./schema";
import { base64ToBytes, bytesToBase64 } from "./bytes";
import { importContentKey, sealText, unsealText } from "./crypto";
import { chapterText, readChapters } from "./book";

/**
 * "Continue with AI": the one feature where prose leaves the vault's keys.
 *
 * The text before the caret is sealed to the model server's own public key and
 * sent through our Worker at /api/complete, which checks the session and
 * relays the envelope — it cannot open it, and neither can Cloudflare under
 * it. Only the machine running the model reads the prompt, which is the
 * irreducible cost of asking a model to continue it; the UI discloses that
 * before the first use (see BookView). The reply comes back sealed to a key
 * that existed only in this function, and is inserted at the caret under the
 * `ai` mark, so suggested words stay visibly washed until the writer makes
 * them their own.
 */

/**
 * Kept in step with the model server's own clamp (wrapper.py). Roughly 100k
 * tokens of a 128k context — book-sized, so in practice the whole story so
 * far goes along, and the model additionally left-truncates anything over.
 */
const MAX_PROMPT_CHARS = 400_000;

/**
 * The model server's P-256 public key (SPKI). Its private half lives in a
 * Modal secret and never leaves that deployment.
 */
const MODEL_SERVER_PUBKEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu2R21glMlfflpQmq2EWeaJWnFonDTQNIwb2K7yJLA9AWkTvO1UJXXLvznWScm7JBjbL2SbmC5nzYds5QmJqVcw==";

const utf8 = new TextEncoder();

/**
 * How much to ask for in one press, chosen from the caret beside the button.
 * Sizes are in model tokens (~¾ of a word each); the server clamps to the
 * same ceiling as the largest option here.
 */
export const AI_LENGTHS = [
  { label: "A beat", hint: "~150 words", tokens: 200 },
  { label: "A passage", hint: "~750 words", tokens: 1024 },
  { label: "A scene", hint: "~1,500 words", tokens: 2048 },
  { label: "A chapter", hint: "~6,000 words", tokens: 8192 },
] as const;

const LENGTH_KEY = "layton:ai-length";
const DEFAULT_TOKENS = 1024;

export function savedAiLength(): number {
  const raw = Number(localStorage.getItem(LENGTH_KEY));
  return AI_LENGTHS.some((l) => l.tokens === raw) ? raw : DEFAULT_TOKENS;
}

export function saveAiLength(tokens: number): void {
  localStorage.setItem(LENGTH_KEY, String(tokens));
}

/**
 * One-shot ECDH against the server key: a fresh ephemeral keypair, then
 * HKDF-SHA256 splits the shared secret into a sealing key for the request and
 * an unsealing key for the response. The ephemeral public key rides along so
 * the server can do the same derivation; its private half is never stored, so
 * a captured exchange cannot be opened later even with the server's key.
 */
export type ContinuationSession = {
  /** Names this generation everywhere: the marker, the store, the request. */
  gen: string;
  epk: string;
  reqKey: CryptoKey;
  resKey: CryptoKey;
  /**
   * The response key's raw bytes, exposed so they can be wrapped under the
   * book key and ride in the pending marker — that wrapped copy is what lets
   * a later session (this tab long closed) still open the stored result.
   */
  resKeyRaw: Uint8Array;
};

export async function prepareContinuation(): Promise<ContinuationSession> {
  const params = { name: "ECDH", namedCurve: "P-256" } as const;
  const serverKey = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(MODEL_SERVER_PUBKEY) as BufferSource,
    params,
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(params, false, [
    "deriveBits",
  ]);
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverKey },
    ephemeral.privateKey,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveBits",
  ]);
  const deriveRaw = async (info: string) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array() as BufferSource,
          info: utf8.encode(info) as BufferSource,
        },
        hkdf,
        256,
      ),
    );
  const resKeyRaw = await deriveRaw("layton-ai/response");
  return {
    gen: crypto.randomUUID(),
    epk: bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
    ),
    reqKey: await importContentKey(await deriveRaw("layton-ai/request")),
    resKey: await importContentKey(resKeyRaw),
    resKeyRaw,
  };
}

/**
 * What the model gets to read: the book's title, every chapter before this
 * one, then this chapter's prose up to the caret. A base model continues raw
 * text, so the shape *is* the instruction — it ends mid-story, and the only
 * thing to do is keep writing. The current chapter's text comes from the live
 * editor (it is ahead of the CRDT by at most a keystroke, and it knows where
 * the caret is); the finished chapters come off the document.
 */
export function promptBeforeCursor(
  view: EditorView,
  doc: LoroDoc,
  activeId: string,
  title: string,
): string {
  const parts: string[] = [];
  if (title.trim()) parts.push(title.trim());
  for (const entry of readChapters(doc)) {
    const heading = entry.title.trim();
    const text =
      entry.id === activeId
        ? view.state.doc.textBetween(0, view.state.selection.from, "\n\n")
        : chapterText(doc, entry.id);
    parts.push([heading, text].filter(Boolean).join("\n\n"));
    if (entry.id === activeId) break;
  }
  // Trailing whitespace would be poison: with the caret on an empty line the
  // prompt would end in a blank line, and the model's opening newlines would
  // complete the server's "\n\n\n" stop sequence — an instant empty reply.
  return parts
    .filter(Boolean)
    .join("\n\n")
    .replace(/\s+$/, "")
    .slice(-MAX_PROMPT_CHARS);
}

/**
 * Live status for pending markers, keyed by generation id. Kept out of the
 * document on purpose: this is transient chatter ("loading weights, 42%"),
 * and writing it into the CRDT would sync every flicker to every device. The
 * marker's nodeView subscribes here instead and paints it locally.
 */
const pendingStatus = new Map<string, string>();
const statusListeners = new Set<() => void>();

export function setPendingStatus(gen: string, status: string | null): void {
  if (status == null) pendingStatus.delete(gen);
  else pendingStatus.set(gen, status);
  for (const listen of statusListeners) listen();
}

/**
 * Renders an ai_pending block: a breathing `· · ·` that swaps to whatever
 * status its generation currently has (waking, loading weights, still
 * writing). Wired into the editor via Editor.tsx's nodeViews.
 */
export function aiPendingNodeView(node: PMNode): NodeViewSpec {
  const gen = node.attrs.gen as string;
  const dom = document.createElement("div");
  dom.className = "ai-pending";
  dom.dataset.aiPending = gen;
  const label = document.createElement("span");
  dom.appendChild(label);
  const paint = () => {
    label.textContent = pendingStatus.get(gen) ?? "";
  };
  paint();
  statusListeners.add(paint);
  return {
    dom,
    update: (next) =>
      next.type.name === "ai_pending" && next.attrs.gen === gen,
    destroy: () => {
      statusListeners.delete(paint);
    },
  };
}

type NodeViewSpec = {
  dom: HTMLElement;
  update: (node: PMNode) => boolean;
  destroy: () => void;
};

/**
 * A cold start loads the model weights, which can take minutes. Rather than spin
 * silently, poll the model's health — which reports how far along the boot
 * is — into the pending marker itself, then come back and try again.
 */
async function waitForModel(
  token: string,
  gen: string,
  signal?: AbortSignal,
): Promise<void> {
  setPendingStatus(gen, "Waking the model…");
  try {
    // Leave room for downloading weights and compiling kernels; a crashed
    // boot aborts early via the "failed" stage.
    for (let i = 0; i < 450; i++) {
      if (signal?.aborted) throw new GenerationStopped("Stopped.");
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const res = await fetch("/api/ai-health", {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (!res?.ok) continue;
      const health = (await res.json().catch(() => null)) as {
        model?: boolean;
        loading?: { stage: string; pct: number | null } | null;
      } | null;
      if (health?.model) return;
      const loading = health?.loading;
      if (loading?.stage === "failed") {
        throw new Error(
          "The model crashed while starting. Try again in a few minutes.",
        );
      }
      if (loading) {
        // Weights stream in with a percentage; then kernels compile in
        // silence for a couple of minutes; then CUDA graphs count up again.
        const message =
          loading.stage === "weights"
            ? `Waking the model — loading weights, ${loading.pct}%`
            : loading.stage === "graphs"
              ? `Waking the model — capturing CUDA graphs, ${loading.pct}%`
              : "Waking the model — compiling kernels, a quiet minute or two";
        setPendingStatus(gen, message);
      }
    }
    throw new Error("The model is taking too long to wake. Try again later.");
  } finally {
    setPendingStatus(gen, null);
  }
}

/**
 * The stream broke after generation had started. The model keeps writing
 * server-side and stores the sealed result, so the caller should leave the
 * pending marker in the document rather than treat this as a plain failure.
 */
export class ConnectionLost extends Error {}

/** The writer pressed Escape: stop putting words on their page. */
export class GenerationStopped extends Error {}

/**
 * Ask for a continuation and hand its text out as it arrives.
 *
 * The response is a stream of sealed envelopes, one per model chunk, each
 * opened here with the response key from this request's ECDH exchange. If the
 * model server is cold, this waits through the load (with a progress toast)
 * and retries once.
 */
export async function streamContinuation(
  session: ContinuationSession,
  prompt: string,
  maxTokens: number,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to use this.");

  const { gen, epk, reqKey, resKey } = session;
  const req = await sealText(reqKey, JSON.stringify({ prompt, maxTokens, gen }));

  const post = async () => {
    try {
      return await fetch("/api/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ epk, req }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new GenerationStopped("Stopped.");
      throw err;
    }
  };

  let res = await post();
  if (res.status === 503) {
    await waitForModel(token, gen, signal);
    res = await post();
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    console.warn("[ai] request failed", { status: res.status, body });
    throw new Error(
      (body as { error?: string } | null)?.error ??
        "The model could not be reached.",
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chars = 0;
  let sawDone = false;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw new GenerationStopped("Stopped.");
      console.warn("[ai] stream interrupted", err);
      throw new ConnectionLost("Connection lost mid-continuation.");
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const sealedLine = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!sealedLine) continue;
      const opened = JSON.parse(await unsealText(resKey, sealedLine)) as {
        t?: string;
        error?: string;
        done?: boolean;
        finishReason?: string;
        promptTokens?: number;
        completionTokens?: number;
      };
      if (opened.error) throw new Error(`The model failed: ${opened.error}`);
      if (opened.t) {
        chars += opened.t.length;
        onDelta(opened.t);
      }
      if (opened.done) {
        sawDone = true;
        // The friendly toast stays vague on purpose; specifics live here.
        console.info("[ai] completion", {
          promptChars: prompt.length,
          promptTokens: opened.promptTokens,
          completionTokens: opened.completionTokens,
          finishReason: opened.finishReason,
          chars,
        });
      }
    }
  }
  // A clean close without the final line means something upstream died; the
  // background generation may still finish, so treat it as a broken wire.
  if (!sawDone) throw new ConnectionLost("The stream ended early.");
}

/**
 * Put a pending-continuation marker into the document at the caret.
 *
 * The marker is a block, so a caret mid-paragraph first splits the paragraph
 * and the marker settles between the halves — the continuation streams into
 * the end of the first half, and the writer's own following prose waits
 * after. `wrappedKey` is the response key sealed under the book key, which is
 * what makes the marker collectable from any device later.
 */
export function placePendingMarker(
  view: EditorView,
  gen: string,
  wrappedKey: string,
): void {
  const tr = view.state.tr;
  if (!tr.selection.empty) tr.deleteSelection();
  const $head = tr.selection.$head;
  const node = schema.nodes.ai_pending.create({ gen, key: wrappedKey });
  if ($head.parentOffset < $head.parent.content.size) {
    tr.split($head.pos);
    const markerPos = tr.selection.$head.before();
    tr.insert(markerPos, node);
    tr.setSelection(TextSelection.create(tr.doc, markerPos - 1));
  } else {
    tr.insert($head.after(), node);
  }
  view.dispatch(tr);
}

/** The marker's position in this document, or null if it was deleted. */
function findMarker(doc: EditorView["state"]["doc"], gen: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type === schema.nodes.ai_pending && node.attrs.gen === gen) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Feeds completion text into the document just before its pending marker,
 * marked `ai`, as it arrives — the words appear the way typing would.
 *
 * Anchoring on the marker rather than a numeric position means concurrent
 * edits anywhere in the chapter cannot derail the stream, and deleting the
 * marker is a natural way to wave the continuation off: with no anchor, the
 * remaining deltas are dropped.
 *
 * The model speaks in newlines and the document in blocks, so runs of \n
 * become paragraph splits; a run cut across two chunks is held as a pending
 * break until prose follows it (which also drops trailing newlines for free).
 */
export class StreamInserter {
  /** Characters actually placed in the document. */
  inserted = 0;
  private view: EditorView;
  private gen: string;
  private pendingBreak = false;

  constructor(view: EditorView, gen: string) {
    this.view = view;
    this.gen = gen;
  }

  push(delta: string): void {
    const { view } = this;
    const markerPos = findMarker(view.state.doc, this.gen);
    if (markerPos == null) return;

    const mark = schema.marks.ai.create();
    const tr = view.state.tr;
    let pos = markerPos;

    // Text lives in textblocks; make sure one precedes the marker (it can
    // stop doing so if the writer deletes the paragraph while we stream).
    const before = tr.doc.resolve(pos).nodeBefore;
    if (!before || !before.isTextblock) {
      tr.insert(pos, schema.nodes.paragraph.create());
      pos += 2;
    }
    let insertAt = pos - 1; // end of the textblock before the marker

    for (const token of delta.replace(/\r/g, "").match(/\n+|[^\n]+/g) ?? []) {
      if (token.startsWith("\n")) {
        this.pendingBreak = true;
        continue;
      }
      if (this.pendingBreak) {
        this.pendingBreak = false;
        if (this.inserted > 0) {
          tr.split(insertAt);
          insertAt += 2; // past the closing and opening block tokens
        }
      }
      tr.insertText(token, insertAt);
      tr.addMark(insertAt, insertAt + token.length, mark);
      insertAt += token.length;
      this.inserted += token.length;
    }

    // Deliberately no selection move and no scrollIntoView: the reader keeps
    // their place while the text pours in; chasing the stream down the page
    // made it unreadable.
    if (tr.docChanged) view.dispatch(tr);
  }

  /** Remove the marker: the continuation is complete (or given up on). */
  finish(): void {
    const { view } = this;
    const markerPos = findMarker(view.state.doc, this.gen);
    if (markerPos == null) return;
    const node = view.state.doc.nodeAt(markerPos);
    view.dispatch(view.state.tr.delete(markerPos, markerPos + (node?.nodeSize ?? 1)));
  }
}

/**
 * Collect what pending markers in this chapter have to show for themselves.
 *
 * For each marker: still generating → leave it breathing; finished → unwrap
 * its response key with the book key, fetch and unseal the stored text, and
 * type it in where the marker stands; expired or unknown → clear the marker
 * so the page doesn't pulse forever over nothing.
 */
export async function recoverPendingMarkers(
  view: EditorView,
  openBytesForBook: (wrapped: string) => Promise<Uint8Array | null>,
): Promise<void> {
  const markers: { gen: string; key: string }[] = [];
  view.state.doc.descendants((node) => {
    if (node.type === schema.nodes.ai_pending) {
      markers.push({
        gen: node.attrs.gen as string,
        key: node.attrs.key as string,
      });
    }
    return true;
  });
  if (markers.length === 0) return;

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return;

  for (const marker of markers) {
    const res = await fetch(
      `/api/ai-result?id=${encodeURIComponent(marker.gen)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => null);
    if (!res?.ok) continue;
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      res?: string;
    } | null;
    if (body?.status === "pending") {
      setPendingStatus(marker.gen, "Still writing — it will appear here.");
      continue;
    }

    const inserter = new StreamInserter(view, marker.gen);
    if (body?.status === "ready" && body.res) {
      const raw = await openBytesForBook(marker.key);
      if (!raw) continue;
      const resKey = await importContentKey(raw);
      raw.fill(0);
      try {
        const opened = JSON.parse(await unsealText(resKey, body.res)) as {
          text?: string;
          finishReason?: string;
        };
        if (opened.text) inserter.push(opened.text);
        inserter.finish();
        console.info("[ai] recovered continuation", {
          gen: marker.gen,
          chars: opened.text?.length ?? 0,
          finishReason: opened.finishReason,
        });
        toast("A continuation finished while you were away — it's in place.");
      } catch (err) {
        console.warn("[ai] could not open stored continuation", err);
      }
    } else {
      // gone, or something unrecognizable — either way, stop the pulsing.
      inserter.finish();
      toast("A pending continuation expired before it could be collected.");
    }
  }
}
