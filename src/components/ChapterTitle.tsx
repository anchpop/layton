import { useLayoutEffect, useRef } from "react";
import type { LoroDoc } from "loro-crdt";

import { useTitleEdit } from "@/hooks/useTitleEdit";
import { renameChapter, type ChapterIndexEntry } from "@/lib/book";

export function ChapterTitle({
  doc,
  chapter,
  number,
  autoFocus,
  onEnter,
}: {
  doc: LoroDoc;
  chapter: ChapterIndexEntry;
  number: number;
  autoFocus: boolean;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const edit = useTitleEdit(
    chapter.title,
    (title) => renameChapter(doc, chapter.id, title),
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
        aria-label="Chapter title"
        placeholder={`Chapter ${number}`}
      />
    </h1>
  );
}
