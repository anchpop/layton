import { useState } from "react";
import { useNavigate } from "react-router";
import { Archive, Lock, LockOpen, Plus } from "lucide-react";
import { toast } from "sonner";

import { useLibrary, type LibraryBook } from "@/hooks/useLibrary";
import { useVaultStatus } from "@/hooks/useVault";
import { lockPrivate } from "@/lib/vault";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "./ThemeToggle";
import { AccountDialog } from "./AccountDialog";
import { UnlockPrivate } from "./UnlockPrivate";

function formatWhen(iso: string): string {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      then.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function Library({ userId, email }: { userId: string; email: string }) {
  const { books, loading, error, createBook, setArchived, setPrivate } =
    useLibrary(userId);
  const { privateUnlocked } = useVaultStatus();
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState(false);
  const navigate = useNavigate();

  async function onCreate() {
    setCreating(true);
    const book = await createBook("Untitled");
    setCreating(false);
    if (book) navigate(`/b/${book.id}`);
  }

  /**
   * There is no archive shelf to browse yet, so the toast is the only route
   * back. It is worth the few lines: a long press is easy to trigger by
   * accident on a phone, and a book vanishing from the only list that shows it
   * — with nothing to press — would read as lost work even though every word
   * is still on the server.
   */
  async function onArchive(book: LibraryBook) {
    if (!(await setArchived(book.id, true))) return;
    toast(`Archived “${book.title || "Untitled"}”`, {
      action: {
        label: "Undo",
        onClick: () => void setArchived(book.id, false),
      },
    });
  }

  async function onSetPrivate(book: LibraryBook, isPrivate: boolean) {
    if (!(await setPrivate(book, isPrivate))) return;
    toast(
      isPrivate
        ? `“${book.title}” is private. It disappears when you lock.`
        : `“${book.title}” is an ordinary book again.`,
    );
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-2xl px-5 pb-24 pt-[max(3rem,env(safe-area-inset-top))] sm:px-6 sm:pt-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-prose text-2xl tracking-tight">Layton</h1>
        <div className="flex items-center gap-1 text-xs">
          <AccountDialog email={email} />
          {/*
            One control, two jobs, and deliberately always present. When the
            key is put away it asks for it; when the key is held it takes it
            back immediately. Always visible because hiding it when there are
            no private books would be the tell: an observer learns that the
            feature exists, never whether this account uses it.
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground"
                aria-label={
                  privateUnlocked ? "Lock private books" : "Unlock private books"
                }
                onClick={() => {
                  if (privateUnlocked) {
                    lockPrivate();
                    setAsking(false);
                  } else {
                    setAsking((open) => !open);
                  }
                }}
              >
                {privateUnlocked ? (
                  <LockOpen className="size-4" />
                ) : (
                  <Lock className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {privateUnlocked ? "Lock private books" : "Private books"}
            </TooltipContent>
          </Tooltip>
          <ThemeToggle className="text-muted-foreground" />
        </div>
      </header>

      {asking && !privateUnlocked && (
        <div className="mt-6 rounded-lg border p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Type your master password to show private books. They hide again
            after fifteen minutes without you.
          </p>
          <UnlockPrivate
            onDone={() => setAsking(false)}
            onCancel={() => setAsking(false)}
          />
        </div>
      )}

      <div className="mt-10 flex items-center justify-between sm:mt-12">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          Your work
        </h2>
        <Button size="sm" disabled={creating} onClick={() => void onCreate()}>
          <Plus className="size-4" />
          {creating ? "Creating…" : "New book"}
        </Button>
      </div>

      {error && <p className="mt-6 text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : books.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed p-10 text-center">
          <p className="font-prose text-lg">Nothing written yet.</p>
        </div>
      ) : (
        <ul className="mt-2">
          {books.map((book) => (
            <li key={book.id} className="border-b">
              {/* Archiving lives here rather than on the row because putting a
                  book away is a once-a-year act and opening one is a daily
                  one. Radix raises this on right-click and on a long press, so
                  it is reachable on a phone without a control sitting next to
                  every title waiting to be hit by mistake. */}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className="w-full rounded-md px-1 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => navigate(`/b/${book.id}`)}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-prose text-lg">
                        {book.title || "Untitled"}
                      </span>
                      {book.isPrivate && (
                        <Lock
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-label="Private"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Edited {formatWhen(book.updated_at)}
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {/* Only offered while the private key is in hand — moving a
                      book needs both keys, and an item that could only ever
                      fail is worse than no item. */}
                  {privateUnlocked &&
                    (book.isPrivate ? (
                      <ContextMenuItem
                        onSelect={() => void onSetPrivate(book, false)}
                      >
                        <LockOpen className="size-4" />
                        Make ordinary
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem
                        onSelect={() => void onSetPrivate(book, true)}
                      >
                        <Lock className="size-4" />
                        Make private
                      </ContextMenuItem>
                    ))}
                  <ContextMenuItem onSelect={() => void onArchive(book)}>
                    <Archive className="size-4" />
                    Archive
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
