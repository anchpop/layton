import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { ContainerID } from "loro-crdt";

import { useBookSync, useChapters, useBookTitle, useSyncState } from "../hooks/useBook";
import { addChapter, bodyContainerId, bookWordCount, setTitle } from "../lib/book";
import { Editor } from "./Editor";
import { ChapterList } from "./ChapterList";
import { SyncBadge } from "./SyncBadge";
import { ThemeToggle } from "./ThemeToggle";

export function BookView({ userId }: { userId: string }) {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();

  const sync = useBookSync(bookId ?? null, userId);
  const doc = sync?.doc ?? null;
  const syncState = useSyncState(sync);
  const chapters = useChapters(doc);
  const title = useBookTitle(doc);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [words, setWords] = useState(0);

  // Keep a valid selection as chapters appear, disappear, or arrive from
  // another device.
  useEffect(() => {
    if (chapters.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !chapters.some((c) => c.id === activeId)) {
      setActiveId(chapters[0].id);
    }
  }, [chapters, activeId]);

  const containerId: ContainerID | null = useMemo(() => {
    if (!doc || !activeId) return null;
    return bodyContainerId(doc, activeId);
  }, [doc, activeId, chapters.length]);

  // Word count is derived from the CRDT, refreshed on a gentle cadence rather
  // than per keystroke — it is ambient information, not a live readout.
  useEffect(() => {
    if (!doc) return;
    const tick = () => setWords(bookWordCount(doc));
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, [doc]);

  // Mirror the title into the library row whenever it settles.
  useEffect(() => {
    if (!sync || syncState.status === "loading") return;
    const id = setTimeout(() => void sync.syncTitleToLibrary(), 1200);
    return () => clearTimeout(id);
  }, [sync, title, syncState.status]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setFocusMode((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!bookId) return null;

  return (
    <div className={`flex h-full ${focusMode ? "focus-mode" : ""}`}>
      {/* ---------------------------------------------------------------- */}
      {/* Sidebar                                                           */}
      {/* ---------------------------------------------------------------- */}
      {sidebarOpen && (
        <aside
          className="chrome flex w-64 shrink-0 flex-col border-r"
          style={{ borderColor: "var(--rule)" }}
        >
          <div className="px-4 pb-3 pt-4">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="text-xs"
              style={{ color: "var(--ink-faint)" }}
            >
              ← All books
            </button>

            <input
              value={titleDraft ?? title}
              onChange={(e) => setTitleDraft(e.target.value)}
              onFocus={() => setTitleDraft(title)}
              onBlur={() => {
                if (doc && titleDraft != null) {
                  setTitle(doc, titleDraft.trim() || "Untitled");
                }
                setTitleDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setTitleDraft(null);
                  e.currentTarget.blur();
                }
              }}
              className="mt-3 w-full bg-transparent text-lg leading-snug outline-none"
              style={{ fontFamily: "var(--font-prose)", color: "var(--ink)" }}
              placeholder="Untitled"
            />
          </div>

          <div className="min-h-0 flex-1">
            {doc && (
              <ChapterList
                doc={doc}
                chapters={chapters}
                activeId={activeId}
                onSelect={setActiveId}
              />
            )}
          </div>

          <div
            className="flex items-center justify-between border-t px-4 py-2.5 text-[0.7rem]"
            style={{ borderColor: "var(--rule)", color: "var(--ink-faint)" }}
          >
            <span>{words.toLocaleString()} words</span>
            <SyncBadge state={syncState} />
          </div>
        </aside>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Writing surface                                                   */}
      {/* ---------------------------------------------------------------- */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div
          className="chrome absolute right-4 top-3 z-10 flex items-center gap-3 text-[0.7rem]"
          style={{ color: "var(--ink-faint)" }}
        >
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setFocusMode((v) => !v)}
            title="Focus mode (⌘.)"
          >
            {focusMode ? "Exit focus" : "Focus"}
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle sidebar (⌘\)"
          >
            {sidebarOpen ? "Hide panel" : "Show panel"}
          </button>
        </div>

        {doc && activeId && containerId ? (
          <Editor doc={doc} containerId={containerId} chapterId={activeId} />
        ) : (
          <div className="flex h-full items-center justify-center">
            {syncState.status === "loading" ? (
              <p className="text-sm" style={{ color: "var(--ink-faint)" }}>
                Opening…
              </p>
            ) : (
              <div className="text-center">
                <p
                  style={{
                    fontFamily: "var(--font-prose)",
                    fontSize: "1.05rem",
                    color: "var(--ink-muted)",
                  }}
                >
                  A blank page.
                </p>
                <button
                  type="button"
                  className="mt-3 rounded-md px-3 py-1.5 text-sm font-medium"
                  style={{ background: "var(--ink)", color: "var(--paper)" }}
                  onClick={() => {
                    if (!doc) return;
                    const created = addChapter(doc, "Chapter One");
                    setActiveId(created.id);
                  }}
                >
                  Begin chapter one
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
