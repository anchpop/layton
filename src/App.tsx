import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useAuth, type AuthUser } from "./hooks/useAuth";
import { usePasskeyGate } from "./hooks/usePasskeyGate";
import { useTheme } from "./components/ThemeToggle";
import { Auth } from "./components/Auth";
import { Library } from "./components/Library";
import { PasskeySetup } from "./components/PasskeySetup";
import { ChunkBoundary } from "./components/ChunkBoundary";
import { UpdatePrompt } from "./components/UpdatePrompt";

// The editor pulls in Loro's wasm bundle and ProseMirror — around a megabyte
// gzipped. Signing in and browsing the library shouldn't pay for that, so it
// loads when the first book is opened.
const BookView = lazy(() =>
  import("./components/BookView").then((m) => ({ default: m.BookView })),
);

export default function App() {
  const { user, loading, offline } = useAuth();
  useTheme(); // applies the stored theme preference on boot

  return (
    <>
      {/* Sits outside the auth branch so a new version can be offered on any
          screen, including the sign-in page of an installed app. */}
      <UpdatePrompt />
      {loading ? (
        <div className="flex min-h-full items-center justify-center">
          <span className="text-sm" style={{ color: "var(--ink-faint)" }}>
            …
          </span>
        </div>
      ) : !user ? (
        <Auth />
      ) : (
        <SignedIn user={user} offline={offline} />
      )}
    </>
  );
}

function SignedIn({ user, offline }: { user: AuthUser; offline: boolean }) {
  const { id: userId, email } = user;
  // Skip the passkey check when we are running on a remembered sign-in — it
  // needs the network, and nothing should stand between an offline writer and
  // their chapter.
  const passkeyGate = usePasskeyGate(offline ? null : userId);

  // Ask once, immediately after a first sign-in, before the library appears.
  if (passkeyGate.state === "prompt") {
    return <PasskeySetup email={email} onDone={passkeyGate.resolve} />;
  }

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
