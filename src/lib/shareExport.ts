import { LoroMap, type LoroDoc } from "loro-crdt";
import { createNodeFromLoroObj, type LoroNode } from "loro-prosemirror";
import { bodiesMap, getTitle, readEntries } from "./book";
import { schema } from "./schema";
import type { SharedStory } from "./share";

type PmJson = {
  content?: PmJson[];
  marks?: { type: string }[];
} & Record<string, unknown>;

/**
 * The `ai` wash is a working annotation — "you didn't write this yet" — and a
 * reader was never going to be told which sentences came from a machine's
 * first draft. It is removed from the export rather than merely unstyled, so
 * the information isn't quietly published either. Pending-continuation
 * markers go the same way: a placeholder for unwritten text is not story.
 */
function stripAiMarks(node: PmJson): PmJson {
  const out: PmJson = { ...node };
  if (out.marks) {
    const marks = out.marks.filter((m) => m.type !== "ai");
    if (marks.length > 0) out.marks = marks;
    else delete out.marks;
  }
  if (out.content) {
    out.content = out.content
      .filter((child) => (child as { type?: string }).type !== "ai_pending")
      .map(stripAiMarks);
  }
  return out;
}

export function exportStory(doc: LoroDoc): SharedStory {
  const bodies = bodiesMap(doc);
  const chapters = readEntries(doc, "chapters").map((entry) => {
    const body = bodies.get(entry.id);
    // A chapter that was never typed in has no nodeName yet — the sync plugin
    // writes it on first contact. Shared as an empty chapter, not an error.
    if (!(body instanceof LoroMap) || typeof body.get("nodeName") !== "string") {
      return { title: entry.title, body: null };
    }
    return {
      title: entry.title,
      body: stripAiMarks(
        createNodeFromLoroObj(
          schema,
          body as unknown as LoroNode,
          new Map(),
        ).toJSON() as PmJson,
      ) as unknown,
    };
  });
  return { v: 1, title: getTitle(doc), chapters };
}

