import { Schema } from "prosemirror-model";

/**
 * A deliberately small schema. Fiction needs paragraphs, emphasis, and a way
 * to mark a scene break — not tables, headings-as-styling, or colour.
 *
 * Keeping the schema tight also keeps the CRDT tree small and makes merges
 * between devices boring, which is exactly what you want.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },

    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },

    /** A section heading within a chapter (rare, but useful for parts). */
    heading: {
      attrs: { level: { default: 2 } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [
        { tag: "h2", attrs: { level: 2 } },
        { tag: "h3", attrs: { level: 3 } },
      ],
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },

    /** The typographic "* * *" that separates scenes. */
    scene_break: {
      group: "block",
      selectable: true,
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr", { class: "scene-break" }],
    },

    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },

    /**
     * A continuation the model is still writing (or finished while no tab was
     * watching). It sits in the document — and therefore syncs, sealed, like
     * any prose — carrying the generation's id and its response key wrapped
     * under the book's key, so whichever device next opens the book can
     * collect the finished text into this exact spot. Stripped from shares.
     */
    ai_pending: {
      attrs: { gen: { default: "" }, key: { default: "" } },
      group: "block",
      atom: true,
      selectable: true,
      parseDOM: [
        {
          tag: "div[data-ai-pending]",
          getAttrs: (el) => ({
            gen: el.getAttribute("data-ai-pending") ?? "",
            key: el.getAttribute("data-ai-key") ?? "",
          }),
        },
      ],
      toDOM: (node) => [
        "div",
        {
          class: "ai-pending",
          "data-ai-pending": node.attrs.gen as string,
          "data-ai-key": node.attrs.key as string,
        },
      ],
    },

    text: { group: "inline" },
  },

  marks: {
    em: {
      parseDOM: [
        { tag: "i" },
        { tag: "em" },
        { style: "font-style=italic" },
      ],
      toDOM: () => ["em", 0],
    },
    strong: {
      parseDOM: [
        { tag: "strong" },
        { tag: "b" },
        { style: "font-weight=bold" },
      ],
      toDOM: () => ["strong", 0],
    },

    /**
     * Prose a model suggested rather than the writer typed, kept visibly
     * washed until they own it. Not inclusive: typing at its edge is the
     * writer's text again. Shared copies strip it — the annotation is for the
     * author, not the audience (see sharePublish.ts).
     */
    ai: {
      inclusive: false,
      parseDOM: [{ tag: "span.ai" }],
      toDOM: () => ["span", { class: "ai" }, 0],
    },
  },
});
