import { LoroDoc, LoroMap, LoroList, LoroText, initSync } from "loro-crdt/web";
import wasm from "loro-crdt/web/loro_wasm_bg.wasm";
import { base64ToBytes } from "../../src/lib/bytes";
import { unseal } from "../../src/lib/crypto";

let initialized = false;

/** Only walk the current document's prose. Attributes, pending AI keys,
 * deleted CRDT history, and unrelated subtrees never enter a tool result. */
function prose(node: unknown): string {
  if (node instanceof LoroText) return node.toString();
  if (!(node instanceof LoroMap)) return "";
  const name = node.get("nodeName");
  if (name === "ai_pending") return "";
  if (name === "scene_break") return "\n* * *\n\n";
  if (!["doc", "paragraph", "heading", "blockquote"].includes(String(name))) return "";
  const children = node.get("children");
  if (!(children instanceof LoroList)) return "";
  const text = children.toArray().map(prose).join("");
  return name === "paragraph" || name === "heading" ? `${text}\n\n` : text;
}

export async function loadStoryDoc(key: CryptoKey, updates: { payload: string }[]) {
  if (!initialized) { initSync({ module: wasm }); initialized = true; }
  const doc = new LoroDoc();
  doc.configTextStyle({ em: { expand: "after" }, strong: { expand: "after" }, ai: { expand: "none" } });
  try {
    for (const row of updates) {
      const bytes = await unseal(key, base64ToBytes(row.payload));
      try {
        const status = doc.import(bytes);
        if (status.pending?.size) throw new Error("Incomplete story; open Layton to sync.");
      } finally { bytes.fill(0); }
    }
    return doc;
  } catch (error) { doc.free(); throw error; }
}

export function currentChapters(doc: LoroDoc) {
  const bodies = doc.getMap("bodies");
  return doc.getMovableList("chapters").toArray().flatMap(entry => {
    if (!(entry instanceof LoroMap)) return [];
    const id = entry.get("id");
    if (typeof id !== "string") return [];
    return [{ id, title: String(entry.get("title") ?? ""), text: prose(bodies.get(id)).trimEnd() }];
  });
}

export async function renderStory(key: CryptoKey, updates: { payload: string }[]) {
  const doc = await loadStoryDoc(key, updates);
  try { return currentChapters(doc); } finally { doc.free(); }
}

export type StoryEdit =
  | { kind: "replace_text"; chapterId: string; oldText: string; newText: string }
  | { kind: "append_to_chapter"; chapterId: string; text: string }
  | { kind: "create_chapter"; title: string; text: string }
  | { kind: "rename_story"; title: string }
  | { kind: "rename_chapter"; chapterId: string; title: string };

function chapterEntry(doc: LoroDoc, id: string): LoroMap {
  const entry = doc.getMovableList("chapters").toArray().find(entry => entry instanceof LoroMap && entry.get("id") === id);
  if (!(entry instanceof LoroMap)) throw new Error("Chapter not found. Read the story again.");
  return entry;
}

function textLeaves(node: unknown): LoroText[] {
  if (node instanceof LoroText) return [node];
  if (!(node instanceof LoroMap) || !["doc", "paragraph", "heading", "blockquote"].includes(String(node.get("nodeName")))) return [];
  const children = node.get("children");
  return children instanceof LoroList ? children.toArray().flatMap(textLeaves) : [];
}

function appendParagraphs(body: LoroMap, text: string) {
  const name = body.get("nodeName");
  if (name !== undefined && name !== "doc") throw new Error("Chapter is not editable. Open it in Layton first.");
  body.set("nodeName", "doc");
  if (!(body.get("attributes") instanceof LoroMap)) body.setContainer("attributes", new LoroMap());
  let children = body.get("children");
  if (!(children instanceof LoroList)) children = body.setContainer("children", new LoroList());
  const list = children as LoroList;
  for (const paragraph of text.replaceAll("\r\n", "\n").split(/\n[ \t]*\n/)) {
    const node = list.pushContainer(new LoroMap());
    node.set("nodeName", paragraph.trim() === "* * *" ? "scene_break" : "paragraph");
    node.setContainer("attributes", new LoroMap());
    const content = node.setContainer("children", new LoroList());
    if (paragraph && node.get("nodeName") === "paragraph") content.pushContainer(new LoroText()).insert(0, paragraph);
  }
}

/** Mutate existing CRDT containers so untouched formatting and offline edits
 * keep their identities. Return only an incremental update to the caller. */
export function applyStoryEdit(doc: LoroDoc, edit: StoryEdit, operationId: string, attribution: { clientId?: string; clientName?: string; connectionId: string }): Uint8Array {
  const before = doc.version();
  if (edit.kind === "rename_story") doc.getMap("meta").set("title", edit.title);
  else if (edit.kind === "create_chapter") {
    if (doc.getMovableList("chapters").toArray().some(entry => entry instanceof LoroMap && entry.get("id") === operationId)) throw new Error("Operation ID already used. Use a new ID for a new edit.");
    const entry = doc.getMovableList("chapters").pushContainer(new LoroMap());
    entry.set("id", operationId); entry.set("title", edit.title);
    appendParagraphs(doc.getMap("bodies").setContainer(operationId, new LoroMap()), edit.text);
  } else {
    const entry = chapterEntry(doc, edit.chapterId);
    if (edit.kind === "rename_chapter") entry.set("title", edit.title);
    else {
      let body = doc.getMap("bodies").get(edit.chapterId);
      if (!(body instanceof LoroMap)) {
        if (edit.kind === "replace_text") throw new Error("Text not found. Read the chapter again.");
        body = doc.getMap("bodies").setContainer(edit.chapterId, new LoroMap());
      }
      if (edit.kind === "append_to_chapter") appendParagraphs(body as LoroMap, edit.text);
      else {
        const matches: { node: LoroText; index: number }[] = [];
        for (const node of textLeaves(body)) {
          const value = node.toString();
          for (let at = value.indexOf(edit.oldText); at >= 0; at = value.indexOf(edit.oldText, at + 1)) {
            matches.push({ node, index: at });
            if (matches.length > 1) throw new Error("Text is ambiguous. Include more surrounding text.");
          }
        }
        if (matches.length !== 1) throw new Error(matches.length ? "Text is ambiguous. Include more surrounding text." : "Text not found. Match exact text within one paragraph, then try again.");
        const { node, index } = matches[0];
        // Match the first replaced character's marks explicitly: inserting at
        // a mark boundary otherwise inherits its outside formatting.
        let offset = 0;
        let attributes: Record<string, unknown> = {};
        for (const delta of node.toDelta()) {
          const length = delta.insert?.length ?? 0;
          if (index < offset + length) { attributes = delta.attributes ?? {}; break; }
          offset += length;
        }
        if (edit.newText) node.insert(index, edit.newText);
        node.delete(index + edit.newText.length, edit.oldText.length);
        if (edit.newText) node.applyDelta([{ retain: index }, { retain: edit.newText.length,
          attributes: { em: null, strong: null, ai: null, ...attributes } }]);
      }
    }
  }
  doc.commit({ origin: "mcp:edit", timestamp: Math.floor(Date.now() / 1000), message: JSON.stringify({
    v: 1, source: "mcp", action: edit.kind, operationId,
    clientId: attribution.clientId, clientName: attribution.clientName ?? "MCP app",
    connectionId: attribution.connectionId,
    ...("chapterId" in edit ? { chapterId: edit.chapterId } : edit.kind === "create_chapter" ? { chapterId: operationId } : {}),
  }) });
  return doc.export({ mode: "update", from: before });
}
