import { LoroDoc, LoroList, LoroMap, LoroMovableList } from "loro-crdt";
import type { ContainerID } from "loro-crdt";

/**
 * A book is a single Loro document. Its shape:
 *
 *   meta      LoroMap        { title: string }
 *   chapters  LoroMovableList[ LoroMap { id: string, title: string } ]
 *   bodies    LoroMap        { [chapterId]: LoroMap }   <- ProseMirror trees
 *
 * The chapter *index* (order + titles) is deliberately kept in a different
 * subtree from the chapter *prose*. Loro delivers events for a container's
 * whole subtree, so if bodies were nested inside the chapter list every
 * keystroke would wake up the sidebar. Split this way, typing only notifies
 * `bodies` and the sidebar re-renders exactly when the index really changes.
 *
 * Reordering uses a movable list so that two devices moving chapters around
 * converge without duplicating or dropping one.
 */

export type ChapterIndexEntry = {
  id: string;
  title: string;
};

const META = "meta";
const CHAPTERS = "chapters";
const BODIES = "bodies";

export function metaMap(doc: LoroDoc): LoroMap {
  return doc.getMap(META);
}

export function chapterList(doc: LoroDoc): LoroMovableList {
  return doc.getMovableList(CHAPTERS);
}

export function bodiesMap(doc: LoroDoc): LoroMap {
  return doc.getMap(BODIES);
}

export function getTitle(doc: LoroDoc): string {
  const t = metaMap(doc).get("title");
  return typeof t === "string" && t.length > 0 ? t : "Untitled";
}

export function setTitle(doc: LoroDoc, title: string): void {
  metaMap(doc).set("title", title);
  doc.commit();
}

export function readChapters(doc: LoroDoc): ChapterIndexEntry[] {
  const list = chapterList(doc);
  const out: ChapterIndexEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list.get(i);
    if (!(entry instanceof LoroMap)) continue;
    const id = entry.get("id");
    if (typeof id !== "string") continue;
    const title = entry.get("title");
    out.push({ id, title: typeof title === "string" ? title : "" });
  }
  return out;
}

function findChapterIndex(doc: LoroDoc, chapterId: string): number {
  const list = chapterList(doc);
  for (let i = 0; i < list.length; i++) {
    const entry = list.get(i);
    if (entry instanceof LoroMap && entry.get("id") === chapterId) return i;
  }
  return -1;
}

export function addChapter(
  doc: LoroDoc,
  title = "",
  atIndex?: number,
): ChapterIndexEntry {
  const list = chapterList(doc);
  const id = crypto.randomUUID();
  const index = atIndex ?? list.length;
  const entry = list.insertContainer(index, new LoroMap());
  entry.set("id", id);
  entry.set("title", title);
  // The body container is created eagerly so the editor always has a stable
  // ContainerID to bind to, even before the first keystroke.
  bodiesMap(doc).setContainer(id, new LoroMap());
  doc.commit();
  return { id, title };
}

export function renameChapter(
  doc: LoroDoc,
  chapterId: string,
  title: string,
): void {
  const i = findChapterIndex(doc, chapterId);
  if (i < 0) return;
  const entry = chapterList(doc).get(i);
  if (entry instanceof LoroMap) {
    entry.set("title", title);
    doc.commit();
  }
}

export function deleteChapter(doc: LoroDoc, chapterId: string): void {
  const i = findChapterIndex(doc, chapterId);
  if (i < 0) return;
  chapterList(doc).delete(i, 1);
  bodiesMap(doc).delete(chapterId);
  doc.commit();
}

export function moveChapter(doc: LoroDoc, from: number, to: number): void {
  const list = chapterList(doc);
  if (from === to || from < 0 || to < 0) return;
  if (from >= list.length || to >= list.length) return;
  list.move(from, to);
  doc.commit();
}

/**
 * ContainerID of a chapter's ProseMirror tree, creating it if a peer added the
 * chapter to the index without (yet) materialising its body.
 */
export function bodyContainerId(
  doc: LoroDoc,
  chapterId: string,
): ContainerID | null {
  if (findChapterIndex(doc, chapterId) < 0) return null;
  const bodies = bodiesMap(doc);
  let body = bodies.get(chapterId);
  if (!(body instanceof LoroMap)) {
    body = bodies.setContainer(chapterId, new LoroMap());
    doc.commit();
  }
  return (body as LoroMap).id;
}

/** Rough word count for a chapter, read straight off the CRDT tree. */
export function chapterWordCount(doc: LoroDoc, chapterId: string): number {
  const body = bodiesMap(doc).get(chapterId);
  if (!(body instanceof LoroMap)) return 0;
  return countWords(body.toJSON());
}

/**
 * Walks a Loro JSON tree summing words in every string it finds.
 *
 * It descends through *all* object values rather than a fixed `children` key,
 * because the same routine has to handle several shapes: the bodies map keyed
 * by chapter id, ProseMirror nodes ({ nodeName, attributes, children }), and
 * rich-text runs that serialise as { insert: "..." } deltas.
 *
 * `nodeName` and `attributes` are skipped — they are structure, not prose, and
 * counting them would inflate the total.
 */
function countWords(node: unknown): number {
  if (node == null) return 0;
  if (typeof node === "string") {
    const trimmed = node.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  }
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, child) => sum + countWords(child), 0);
  }
  if (typeof node === "object") {
    let total = 0;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "nodeName" || key === "attributes") continue;
      total += countWords(value);
    }
    return total;
  }
  return 0;
}

export function bookWordCount(doc: LoroDoc): number {
  return countWords(bodiesMap(doc).toJSON());
}

/**
 * The chapter's prose as plain text — blocks separated by blank lines, scene
 * breaks as the same `* * *` you'd type to make one. This is for building the
 * AI continuation prompt, so ordinary readable text is the goal, not
 * round-trippable structure.
 */
export function chapterText(doc: LoroDoc, chapterId: string): string {
  const body = bodiesMap(doc).get(chapterId);
  if (!(body instanceof LoroMap)) return "";
  return textOf(body.toJSON());
}

const BLOCK_NODES = new Set(["paragraph", "heading", "blockquote", "scene_break"]);

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    const isBlocks = node.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        BLOCK_NODES.has((child as Record<string, unknown>).nodeName as string),
    );
    const parts = node.map(textOf);
    return isBlocks ? parts.filter(Boolean).join("\n\n") : parts.join("");
  }
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.nodeName === "scene_break") return "* * *";
    let out = "";
    for (const [key, value] of Object.entries(record)) {
      if (key === "nodeName" || key === "attributes") continue;
      out += textOf(value);
    }
    return out;
  }
  return "";
}

export { LoroDoc, LoroList, LoroMap, LoroMovableList };
