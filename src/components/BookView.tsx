import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ChevronLeft, Lock, Maximize2, Minimize2 } from "lucide-react";
import type { ContainerID } from "loro-crdt";

import {
  useBookSync,
  useChapters,
  useBookTitle,
  useSyncState,
} from "@/hooks/useBook";
import { useVaultStatus } from "@/hooks/useVault";
import {
  addChapter,
  bodyContainerId,
  bookWordCount,
  setTitle,
} from "@/lib/book";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Editor } from "./Editor";
import { ChapterList } from "./ChapterList";
import { SyncBadge } from "./SyncBadge";
import { ThemeToggle } from "./ThemeToggle";
import { UnlockPrivate } from "./UnlockPrivate";

/**
 * A private book, reached while its key is put away — by the idle timer, by the
 * lock button, or by opening its address in a browser that has never had it.
 *
 * The title is not shown, because it is not known: it is sealed under the same
 * key as the prose. All this page can honestly say is that something is here.
 */
function LockedBook({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full w-full flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Lock className="size-5 text-muted-foreground" />
        <h1 className="mt-3 font-prose text-xl tracking-tight">
          This book is locked.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Type your master password to open it. Your place is kept.
        </p>
        <UnlockPrivate className="mt-4" />
        <Button
          variant="link"
          className="mt-4 h-auto p-0 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-3" />
          All books
        </Button>
      </div>
    </div>
  );
}

/**
 * No wrapper for this book could be found, on the server or on this device.
 *
 * Distinct from locked on purpose. A password prompt here would be an
 * instruction that cannot work: there is no key to hand over, because there is
 * nothing to unlock — the book has been deleted, or this device has never seen
 * it and cannot reach the server to ask.
 */
function BookUnavailable({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full w-full flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="font-prose text-xl tracking-tight">
          This book could not be opened.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It is not on this device, and the server did not offer it. If you are
          offline, reload this page once you are back.
        </p>
        <Button
          variant="link"
          className="mt-4 h-auto p-0 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-3" />
          All books
        </Button>
      </div>
    </div>
  );
}

/**
 * The status bar sits over the app in an installed iOS PWA (viewport-fit=cover
 * plus a translucent status bar), so anything pinned to the top has to make
 * room for it or the controls end up under the clock.
 */
const SAFE_TOP = "env(safe-area-inset-top, 0px)";
const SAFE_BOTTOM = "env(safe-area-inset-bottom, 0px)";
// Landscape on a notched iPhone puts the sensor housing on one side.
const SAFE_LEFT = "env(safe-area-inset-left, 0px)";
const SAFE_RIGHT = "env(safe-area-inset-right, 0px)";

export function BookView({ userId }: { userId: string }) {
  const { bookId } = useParams<{ bookId: string }>();
  // Focus mode lives above the provider so the class can wrap *both* the
  // sidebar and the editor. On SidebarInset alone it could never reach the
  // sidebar, which is its sibling — and hiding the chapter panel is most of
  // the point of focus mode.
  const [focusMode, setFocusMode] = useState(false);
  // The panel is controlled here so entering focus mode can close it at the
  // transition. Syncing it from an effect would fight the user: shadcn rebuilds
  // `setOpen` whenever `open` changes, so the effect would re-fire on every
  // manual toggle and immediately undo it.
  const [sidebarOpen, setSidebarOpen] = useState(true);

  if (!bookId) return null;

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => {
        setSidebarOpen(open);
        // Asking for the panel back — via the trigger or Cmd+\ — means you are
        // done being undistracted. Leaving focusMode true here would strand it
        // showing an opaque sidebar it believes is hidden.
        if (open) setFocusMode(false);
      }}
      /**
       * The editor is an app shell, not a document: the window never scrolls,
       * the prose pane does.
       *
       * shadcn's wrapper ships `min-h-svh`, which only sets a floor — the flex
       * column below it still sizes to its content, so `flex-1 overflow-y-auto`
       * on the prose pane grew to the full height of the chapter instead of
       * scrolling. That left two scrollers stacked on the same gesture (the
       * window, and a prose pane with only its trailing padding to give), and
       * Chrome latches a wheel gesture to whichever it hits first, so a scroll
       * would travel a few hundred pixels and then refuse to continue.
       *
       * A definite height is what actually constrains the column; `overflow-hidden`
       * keeps a future overgrown child from quietly reopening a window scrollbar.
       * `svh` rather than `dvh` so a phone hiding its browser chrome mid-scroll
       * does not resize the shell underneath the caret.
       */
      className={cn("h-svh overflow-hidden", focusMode && "focus-mode")}
    >
      <BookWorkspace
        bookId={bookId}
        userId={userId}
        focusMode={focusMode}
        setFocusMode={setFocusMode}
        setSidebarOpen={setSidebarOpen}
      />
    </SidebarProvider>
  );
}

function BookWorkspace({
  bookId,
  userId,
  focusMode,
  setFocusMode,
  setSidebarOpen,
}: {
  bookId: string;
  userId: string;
  focusMode: boolean;
  setFocusMode: (focused: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { isMobile, openMobile, setOpenMobile } = useSidebar();

  /**
   * Entering focus mode puts away whichever panel is showing. The desktop
   * panel and the mobile drawer are separate state inside shadcn's provider,
   * so this has to live in here to reach both — getting one and not the other
   * would leave the drawer sitting over a supposedly distraction-free page.
   */
  const toggleFocus = useCallback(() => {
    const nowFocused = !focusMode;
    setFocusMode(nowFocused);
    setSidebarOpen(!nowFocused);
    if (nowFocused) setOpenMobile(false);
  }, [focusMode, setFocusMode, setSidebarOpen, setOpenMobile]);

  // Opening the drawer is the mobile half of that same invariant. shadcn routes
  // mobile toggles through its own `openMobile` state rather than the
  // `onOpenChange` the desktop panel uses, so it cannot be caught up there.
  useEffect(() => {
    if (openMobile && focusMode) setFocusMode(false);
  }, [openMobile, focusMode, setFocusMode]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleFocus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFocus]);

  const sync = useBookSync(bookId, userId);
  const doc = sync?.doc ?? null;
  const syncState = useSyncState(sync);
  const { privateUnlocked } = useVaultStatus();
  const chapters = useChapters(doc);
  const title = useBookTitle(doc);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Set by Escape. `setTitleDraft(null)` cannot do this job: blur() fires
  // synchronously and its handler still sees the pre-Escape draft, so the
  // cancelled edit would be saved anyway.
  const titleEditCancelled = useRef(false);
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

  // Word count is derived from the CRDT on a gentle cadence rather than per
  // keystroke — it is ambient information, not a live readout.
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

  /**
   * Picking a chapter to read closes the drawer on a phone. Creating one does
   * not: the sidebar is where you name it, and closing the drawer would unmount
   * the rename field before you could type in it.
   */
  function selectChapter(id: string, { closePanel = true } = {}) {
    setActiveId(id);
    if (isMobile && closePanel) setOpenMobile(false);
  }

  if (syncState.status === "unavailable") {
    return <BookUnavailable onBack={() => navigate("/")} />;
  }

  /**
   * Two ways to be locked, and both have to be checked here.
   *
   * The engine reports `locked` when it never unwrapped a key, so nothing of
   * the book ever reached memory. But when the vault locks *while this page is
   * open*, the engine is rebuilt by an effect — and an effect runs after the
   * render it was scheduled by, which would put one painted frame of private
   * prose on screen after the lock. Deriving the second condition from the
   * vault as it is right now means that frame does not exist.
   */
  if (syncState.status === "locked" || (syncState.isPrivate && !privateUnlocked)) {
    return <LockedBook onBack={() => navigate("/")} />;
  }

  return (
    <>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader
          className="gap-2"
          style={{ paddingTop: `calc(0.5rem + ${SAFE_TOP})` }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-fit gap-1 px-2 text-muted-foreground"
            onClick={() => navigate("/")}
          >
            <ChevronLeft className="size-4" />
            All books
          </Button>

          <Input
            value={titleDraft ?? title}
            onChange={(e) => setTitleDraft(e.target.value)}
            onFocus={() => setTitleDraft(title)}
            onBlur={() => {
              if (titleEditCancelled.current) {
                titleEditCancelled.current = false;
              } else if (doc && titleDraft != null) {
                setTitle(doc, titleDraft.trim() || "Untitled");
              }
              setTitleDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                titleEditCancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            placeholder="Untitled"
            aria-label="Book title"
            className="h-auto border-0 bg-transparent px-2 py-1 font-prose !text-lg shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </SidebarHeader>

        <SidebarContent>
          {doc && (
            <ChapterList
              doc={doc}
              chapters={chapters}
              activeId={activeId}
              onSelect={selectChapter}
            />
          )}
        </SidebarContent>

        <SidebarFooter
          className="flex-row items-center justify-between border-t px-3 py-2 text-[0.7rem] text-muted-foreground"
          style={{ paddingBottom: `calc(0.5rem + ${SAFE_BOTTOM})` }}
        >
          <span>{words.toLocaleString()} words</span>
          <SyncBadge state={syncState} />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0">
        {/* Not sticky: the bar is a sibling of the scroll pane, not a passenger
            inside it, so it stays put on its own. It used to need `sticky` and a
            translucent blur because the whole window scrolled and prose ran
            underneath — with the shell pinned there is nothing behind it to
            blur, and a full-width backdrop-filter is a repaint on every frame. */}
        <header
          className="chrome z-10 flex shrink-0 items-center gap-1 bg-background"
          style={{
            height: `calc(3rem + ${SAFE_TOP})`,
            paddingTop: SAFE_TOP,
            paddingLeft: `calc(0.5rem + ${SAFE_LEFT})`,
            paddingRight: `calc(0.5rem + ${SAFE_RIGHT})`,
          }}
        >
          <SidebarTrigger className="text-muted-foreground" />
          <div className="flex-1" />
          <ThemeToggle className="text-muted-foreground" />
          <Button
            variant="ghost"
            size="icon"
            aria-label={focusMode ? "Leave focus mode" : "Focus mode (⌘.)"}
            title={focusMode ? "Leave focus mode" : "Focus mode (⌘.)"}
            className="text-muted-foreground"
            onClick={toggleFocus}
          >
            {focusMode ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </Button>
        </header>

        {/* SidebarInset already renders <main>; a nested one would be invalid. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {doc && activeId && containerId ? (
            <Editor doc={doc} containerId={containerId} chapterId={activeId} />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              {syncState.status === "loading" ? (
                <p className="text-sm text-muted-foreground">Opening…</p>
              ) : (
                <div className="text-center">
                  <p className="font-prose text-lg text-muted-foreground">
                    A blank page.
                  </p>
                  <Button
                    className="mt-4"
                    onClick={() => {
                      if (!doc) return;
                      const created = addChapter(doc, "Chapter One");
                      setActiveId(created.id);
                    }}
                  >
                    Begin chapter one
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </SidebarInset>
    </>
  );
}
