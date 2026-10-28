import { useLayoutEffect, useRef } from "react";
import type { LoroDoc } from "loro-crdt";

import { useTitleEdit } from "@/hooks/useTitleEdit";
import { renameEntry, titlePlaceholder, type IndexEntry, type Section } from "@/lib/book";

export function ChapterTitle({
  doc,
  chapter,
  section,
  number,
  autoFocus,
  onEnter,
}: {
  doc: LoroDoc;
  chapter: IndexEntry;
  section: Section;
  /** Position in its section, for the "Chapter N" placeholder. */
  number: number;
  autoFocus: boolean;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const edit = useTitleEdit(
    chapter.title,
    (title) => renameEntry(doc, chapter.id, title),
    { onEnter },
  );

  useLayoutEffect(() => {
    const field = ref.current!;
    const resize = () => {
      field.style.height = "0px";
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    // field-sizing isn't available in every installed iOS PWA. Measuring also
    // handles a title wrapping again when the sidebar or the viewport changes.
    const observer = new ResizeObserver(resize);
    observer.observe(field.parentElement!);
    return () => observer.disconnect();
  }, [edit.value]);

  return (
    <h1 className="chapter-heading">
      <textarea
        ref={ref}
        {...edit}
        rows={1}
        autoFocus={autoFocus}
        aria-label={section === "chapters" ? "Chapter title" : "Note title"}
        placeholder={titlePlaceholder(section, number)}
      />
    </h1>
  );
}
