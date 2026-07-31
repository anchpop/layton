import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { useAuth } from "./hooks/useAuth";
import { useTheme } from "./components/ThemeToggle";
import { Auth } from "./components/Auth";
import { Library } from "./components/Library";
import { ChunkBoundary } from "./components/ChunkBoundary";

// The editor pulls in Loro's wasm bundle and ProseMirror — around a megabyte
// gzipped. Signing in and browsing the library shouldn't pay for that, so it
// loads when the first book is opened.
const BookView = lazy(() =>
  import("./components/BookView").then((m) => ({ default: m.BookView })),
);

export default function App() {
  const { session, loading } = useAuth();
  useTheme(); // applies the stored theme preference on boot

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <span className="text-sm" style={{ color: "var(--ink-faint)" }}>
          …
        </span>
      </div>
    );
  }

  if (!session) return <Auth />;

  const userId = session.user.id;
  const email = session.user.email ?? "";

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library userId={userId} email={email} />} />
        <Route
          path="/b/:bookId"
          element={
            <ChunkBoundary>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <span
                      className="text-sm"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      Opening…
                    </span>
                  </div>
                }
              >
                <BookView userId={userId} />
              </Suspense>
            </ChunkBoundary>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
