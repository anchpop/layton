import { useEffect, useRef } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import {
  inputRules,
  smartQuotes,
  textblockTypeInputRule,
  InputRule,
} from "prosemirror-inputrules";
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  undo,
  redo,
  type LoroDocType,
} from "loro-prosemirror";
import type { LoroDoc } from "loro-crdt";
import type { ContainerID } from "loro-crdt";

import { schema } from "../lib/schema";
import { aiPendingNodeView } from "../lib/autocomplete";

type Props = {
  doc: LoroDoc;
  containerId: ContainerID;
  /** Remount key: switching chapters must rebuild the view against a new container. */
  chapterId: string;
  /**
   * Hands the live EditorView to whoever mounted us (and null when it dies),
   * so chrome outside the editor — the continue-with-AI button — can read the
   * caret and dispatch. Must be referentially stable or the editor rebuilds.
   */
  onViewReady?: (view: EditorView | null) => void;
};

/** Typographic niceties that matter for prose. */
function fictionInputRules() {
  return inputRules({
    rules: [
      ...smartQuotes,
      // "--" becomes an em dash, the workhorse of dialogue.
      new InputRule(/--$/, "—"),
      new InputRule(/\.\.\.$/, "…"),
      // "* * *", "***" or "---" alone on a line becomes a scene break.
      //
      // The whole paragraph is replaced, not just the matched text: a
      // scene_break is a block node, and dropping one into an inline range
      // silently fails to fit. An empty paragraph is appended after it so
      // there is somewhere to keep writing.
      new InputRule(/^(?:\*\s?\*\s?\*|---)\s$/, (state, _match, start) => {
        const $start = state.doc.resolve(start);
        const from = $start.before($start.depth);
        const to = $start.after($start.depth);
        const tr = state.tr.replaceWith(from, to, [
          schema.nodes.scene_break.create(),
          schema.nodes.paragraph.create(),
        ]);
        // +1 clears the scene break, +1 more enters the new paragraph.
        return tr.setSelection(TextSelection.create(tr.doc, from + 2));
      }),
      textblockTypeInputRule(/^##\s$/, schema.nodes.heading, { level: 2 }),
      textblockTypeInputRule(/^###\s$/, schema.nodes.heading, { level: 3 }),
    ],
  });
}

export function Editor({ doc, containerId, chapterId, onViewReady }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const state = EditorState.create({
      schema,
      plugins: [
        // Binds this editor to one chapter's subtree of the book document.
        //
        // The cast is safe and necessary: LoroSyncPlugin types `doc` as a
        // document whose *root* holds the ProseMirror tree. We pass an explicit
        // containerId instead, so the plugin reads that container and never
        // touches the root shape its type describes.
        LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId }),
        // CRDT-aware undo: only ever undoes *your* edits, never a collaborator's.
        LoroUndoPlugin({ doc }),
        fictionInputRules(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
          "Mod-b": toggleMark(schema.marks.strong),
          "Mod-i": toggleMark(schema.marks.em),
          "Mod-Alt-1": setBlockType(schema.nodes.paragraph),
          "Mod-Alt-2": setBlockType(schema.nodes.heading, { level: 2 }),
        }),
        keymap(baseKeymap),
      ],
    });

    const view = new EditorView(mount, {
      state,
      attributes: {
        class: "prose-surface",
        spellcheck: "true",
      },
      nodeViews: {
        // Pending AI markers paint their live status ("loading weights, 42%")
        // from a local store, so none of that chatter enters the document.
        ai_pending: (node) => aiPendingNodeView(node),
      },
    });
    viewRef.current = view;
    onViewReady?.(view);

    // Take focus only if nothing else wants it. Creating a chapter puts the
    // caret in the sidebar's rename field and mounts this editor in the same
    // commit — focusing unconditionally would yank the caret out mid-word.
    const active = document.activeElement;
    if (!active || active === document.body) view.focus();

    return () => {
      onViewReady?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [doc, containerId, chapterId, onViewReady]);

  return <div ref={mountRef} className="editor-mount" />;
}
