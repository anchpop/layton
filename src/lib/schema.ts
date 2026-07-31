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
  },
});
