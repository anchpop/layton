import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

type TitleField = HTMLInputElement | HTMLTextAreaElement;

/** A title stays live until we actually type; merely focusing it must not
 * overwrite a rename arriving from another device when we leave the field. */
export function useTitleEdit(
  title: string,
  commit: (title: string) => void,
  { onFinish, onEnter }: { onFinish?: () => void; onEnter?: () => void } = {},
) {
  const [draft, setDraft] = useState<string | null>(null);
  // blur() is synchronous: state alone would still expose the cancelled draft
  // to its handler in the same key event.
  const cancelled = useRef(false);
  return {
    value: draft ?? title,
    onChange: (event: ChangeEvent<TitleField>) => setDraft(event.target.value),
    onBlur: () => {
      if (!cancelled.current && draft != null) commit(draft.trim());
      cancelled.current = false;
      setDraft(null);
      onFinish?.();
    },
    onKeyDown: (event: KeyboardEvent<TitleField>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = event.key === "Escape";
      event.currentTarget.blur();
      if (event.key === "Enter") onEnter?.();
    },
  };
}
