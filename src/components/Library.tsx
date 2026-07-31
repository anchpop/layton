import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";

import { useLibrary } from "@/hooks/useLibrary";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ThemeToggle } from "./ThemeToggle";
import { PasskeyPanel } from "./PasskeyPanel";

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
  const { books, loading, error, createBook, deleteBook } = useLibrary(userId);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  async function onCreate() {
    setCreating(true);
    const book = await createBook("Untitled");
    setCreating(false);
    if (book) navigate(`/b/${book.id}`);
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-2xl px-5 pb-24 pt-[max(3rem,env(safe-area-inset-top))] sm:px-6 sm:pt-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-prose text-2xl tracking-tight">Layton</h1>
        <div className="flex items-center gap-1 text-xs">
          <span className="hidden text-muted-foreground sm:inline">
            {email}
          </span>
          <ThemeToggle className="text-muted-foreground" />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </Button>
        </div>
      </header>

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
            <li key={book.id} className="group border-b">
              <div className="flex items-center gap-2 py-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => navigate(`/b/${book.id}`)}
                >
                  <span className="block truncate font-prose text-lg">
                    {book.title || "Untitled"}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Edited {formatWhen(book.updated_at)}
                  </span>
                </button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs text-muted-foreground transition can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100"
                    >
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete “{book.title || "Untitled"}”?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Every chapter in this book is deleted from your account
                        and from this device. It cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => void deleteBook(book.id)}
                      >
                        Delete forever
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </li>
          ))}
        </ul>
      )}

      <PasskeyPanel />
    </div>
  );
}
