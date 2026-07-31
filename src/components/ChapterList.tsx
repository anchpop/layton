import { useEffect, useRef, useState } from "react";
import type { LoroDoc } from "loro-crdt";

import type { ChapterIndexEntry } from "../lib/book";
import { addChapter, deleteChapter, moveChapter, renameChapter } from "../lib/book";

type Props = {
  doc: LoroDoc;
  chapters: ChapterIndexEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
};

export function ChapterList({ doc, chapters, activeId, onSelect }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  function commitRename() {
    if (!editingId) return;
    renameChapter(doc, editingId, draft.trim());
    setEditingId(null);
  }

  function onDrop(target: number) {
    if (dragIndex != null && dragIndex !== target) {
      moveChapter(doc, dragIndex, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-1">
        <span
          className="text-[0.65rem] uppercase tracking-widest"
          style={{ color: "var(--ink-faint)" }}
        >
          Chapters
        </span>
        <button
          type="button"
          title="New chapter"
          className="text-lg leading-none"
          style={{ color: "var(--ink-faint)" }}
          onClick={() => {
            const created = addChapter(doc, "");
            onSelect(created.id);
            setEditingId(created.id);
            setDraft("");
          }}
        >
          +
        </button>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {chapters.map((chapter, index) => {
          const isActive = chapter.id === activeId;
          const isOver = overIndex === index && dragIndex !== index;
          return (
            <li
              key={chapter.id}
              draggable={editingId !== chapter.id}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(index);
              }}
              onDragLeave={() => setOverIndex((i) => (i === index ? null : i))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(index);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className="group relative rounded-md"
              style={{
                background: isActive ? "var(--paper-raised)" : "transparent",
                boxShadow: isOver ? "inset 0 2px 0 0 var(--accent)" : undefined,
                opacity: dragIndex === index ? 0.4 : 1,
              }}
            >
              {editingId === chapter.id ? (
                <input
                  ref={inputRef}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  placeholder={`Chapter ${index + 1}`}
                  className="w-full bg-transparent px-2 py-1.5 text-sm outline-none"
                  style={{ color: "var(--ink)" }}
                />
              ) : (
                <div className="flex items-center">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                    style={{
                      color: isActive ? "var(--ink)" : "var(--ink-muted)",
                    }}
                    onClick={() => onSelect(chapter.id)}
                    onDoubleClick={() => {
                      setEditingId(chapter.id);
                      setDraft(chapter.title);
                    }}
                  >
                    <span
                      className="mr-2 tabular-nums"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      {index + 1}.
                    </span>
                    {chapter.title || (
                      <span style={{ color: "var(--ink-faint)" }}>Untitled</span>
                    )}
                  </button>
                  <button
                    type="button"
                    title="Delete chapter"
                    className="mr-1 shrink-0 px-1.5 text-xs opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                    style={{ color: "var(--ink-faint)" }}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${chapter.title || "Untitled"}"? This cannot be undone.`,
                        )
                      ) {
                        deleteChapter(doc, chapter.id);
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </li>
          );
        })}

        {chapters.length === 0 && (
          <li className="px-2 py-3 text-sm" style={{ color: "var(--ink-faint)" }}>
            No chapters yet.
          </li>
        )}
      </ol>
    </div>
  );
}
