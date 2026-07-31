import { useState } from "react";
import { useNavigate } from "react-router";

import { useLibrary } from "../hooks/useLibrary";
import { supabase } from "../lib/supabase";
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
    year: then.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function Library({ userId, email }: { userId: string; email: string }) {
  const { books, loading, error, createBook, deleteBook } = useLibrary(userId);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const navigate = useNavigate();

  async function onCreate() {
    setCreating(true);
    const book = await createBook("Untitled");
    setCreating(false);
    if (book) navigate(`/b/${book.id}`);
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-2xl px-6 py-16">
      <header className="flex items-baseline justify-between">
        <h1
          className="text-2xl tracking-tight"
          style={{ fontFamily: "var(--font-prose)" }}
        >
          Layton
        </h1>
        <div className="flex items-center gap-4 text-xs">
          <ThemeToggle />
          <span style={{ color: "var(--ink-faint)" }}>{email}</span>
          <button
            type="button"
            className="underline underline-offset-4"
            style={{ color: "var(--ink-muted)" }}
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mt-12 flex items-center justify-between">
        <h2
          className="text-xs uppercase tracking-widest"
          style={{ color: "var(--ink-faint)" }}
        >
          Your work
        </h2>
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={creating}
          className="rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40"
          style={{ background: "var(--ink)", color: "var(--paper)" }}
        >
          {creating ? "Creating…" : "New book"}
        </button>
      </div>

      {error && (
        <p className="mt-6 text-sm" style={{ color: "#b4483c" }}>
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-8 text-sm" style={{ color: "var(--ink-faint)" }}>
          Loading…
        </p>
      ) : books.length === 0 ? (
        <div
          className="mt-8 rounded-lg border border-dashed p-10 text-center"
          style={{ borderColor: "var(--rule)" }}
        >
          <p style={{ fontFamily: "var(--font-prose)", fontSize: "1.05rem" }}>
            Nothing written yet.
          </p>
        </div>
      ) : (
        <ul className="mt-4">
          {books.map((book) => (
            <li
              key={book.id}
              className="group border-b"
              style={{ borderColor: "var(--rule)" }}
            >
              <div className="flex items-center gap-4 py-4">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => navigate(`/b/${book.id}`)}
                >
                  <div
                    className="truncate"
                    style={{
                      fontFamily: "var(--font-prose)",
                      fontSize: "1.075rem",
                    }}
                  >
                    {book.title || "Untitled"}
                  </div>
                  <div
                    className="mt-0.5 text-xs"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    Edited {formatWhen(book.updated_at)}
                  </div>
                </button>

                {confirming === book.id ? (
                  <span className="flex shrink-0 items-center gap-3 text-xs">
                    <button
                      type="button"
                      style={{ color: "#b4483c" }}
                      onClick={() => {
                        setConfirming(null);
                        void deleteBook(book.id);
                      }}
                    >
                      Delete forever
                    </button>
                    <button
                      type="button"
                      style={{ color: "var(--ink-muted)" }}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="shrink-0 text-xs opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                    style={{ color: "var(--ink-faint)" }}
                    onClick={() => setConfirming(book.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <PasskeyPanel />
    </div>
  );
}
