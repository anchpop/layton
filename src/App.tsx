import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { useAuth, type AuthUser } from "@/hooks/useAuth";
import { usePasskeyGate } from "@/hooks/usePasskeyGate";
import { useVault } from "@/hooks/useVault";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Auth } from "@/components/Auth";
import { Library } from "@/components/Library";
import { PasskeySetup } from "@/components/PasskeySetup";
import { VaultSetup } from "@/components/VaultSetup";
import { VaultUnlock } from "@/components/VaultUnlock";
import { ChunkBoundary } from "@/components/ChunkBoundary";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

// The editor pulls in Loro's wasm bundle and ProseMirror — around a megabyte
// gzipped. Signing in and browsing the library shouldn't pay for that, so it
// loads when the first book is opened.
const BookView = lazy(() =>
  import("@/components/BookView").then((m) => ({ default: m.BookView })),
);
// The shared-story reader is public and prose-only — no Loro, no vault — so a
// link opened by someone who has never signed in loads a small chunk, not the
// editor.
const SharedStory = lazy(() =>
  import("@/components/SharedStory").then((m) => ({ default: m.SharedStory })),
);

export default function App() {
  const { user, loading, offline } = useAuth();

  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
      {/* Sits outside the auth branch so a new version can be offered on any
          screen, including the sign-in page of an installed app. */}
      <UpdatePrompt />
      {/* Clear the home indicator in an installed iOS app. */}
      <Toaster
        position="bottom-center"
        offset={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
        mobileOffset={{
          bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
        }}
      />
      <BrowserRouter>
        <Routes>
          {/* A shared story answers to its link alone. It sits outside the
              auth branch because its reader has no account here — the story's
              key arrives in the URL fragment, not from any vault. */}
          <Route
            path="/s/:shareId"
            element={
              <ChunkBoundary>
                <Suspense
                  fallback={
                    <div className="flex min-h-full items-center justify-center">
                      <span className="text-sm text-muted-foreground">
                        Opening…
                      </span>
                    </div>
                  }
                >
                  <SharedStory />
                </Suspense>
              </ChunkBoundary>
            }
          />
          <Route
            path="/*"
            element={
              loading ? (
                <div className="flex min-h-full items-center justify-center">
                  <span className="text-sm text-muted-foreground">…</span>
                </div>
              ) : !user ? (
                <Auth />
              ) : (
                // Keyed by account so a session replaced with another one gets
                // a fresh subtree rather than the old one re-deriving itself.
                // Every gate, every decrypted title and every sync engine below
                // here belongs to exactly one account, and remounting is the
                // only way to say that which cannot be got wrong by an effect
                // running a render too late.
                <SignedIn key={user.id} user={user} offline={offline} />
              )
            }
          />
        </Routes>
      </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  );
}

function SignedIn({ user, offline }: { user: AuthUser; offline: boolean }) {
  const { id: userId, email } = user;
  // Skip the passkey check when we are running on a remembered sign-in — it
  // needs the network, and nothing should stand between an offline writer and
  // their chapter.
  const passkeyGate = usePasskeyGate(offline ? null : userId);
  const { gate: vault, recheck: recheckVault } = useVault(userId);

  // Ask once, immediately after a first sign-in, before the library appears.
  if (passkeyGate.state === "prompt") {
    return <PasskeySetup email={email} onDone={passkeyGate.resolve} />;
  }

  /**
   * Nothing past this point can render without a key. Unlike the passkey gate
   * above, this one cannot fail open: the library, the editor and the sync
   * engine all read ciphertext, so letting them through unlocked would not show
   * a degraded app — it would show an empty one.
   */
  if (vault === "checking") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <span className="text-sm text-muted-foreground">…</span>
      </div>
    );
  }
  if (vault === "setup") return <VaultSetup userId={userId} email={email} />;
  if (vault === "locked") {
    return (
      <VaultUnlock userId={userId} email={email} onErased={recheckVault} />
    );
  }

  // Descendant routes of the catch-all in App: the router is mounted up there,
  // outside the auth branch, so the shared-story page can exist without a
  // session. Everything signed-in resolves here.
  return (
    <Routes>
      <Route path="/" element={<Library userId={userId} email={email} />} />
      <Route
        path="/b/:bookId"
        element={
          <ChunkBoundary>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <span className="text-sm text-muted-foreground">
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
  );
}
