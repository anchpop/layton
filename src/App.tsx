import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { useAuth, type AuthUser } from "@/hooks/useAuth";
import { usePasskeyGate } from "@/hooks/usePasskeyGate";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Auth } from "@/components/Auth";
import { Library } from "@/components/Library";
import { PasskeySetup } from "@/components/PasskeySetup";
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
      {loading ? (
        <div className="flex min-h-full items-center justify-center">
          <span className="text-sm text-muted-foreground">…</span>
        </div>
      ) : !user ? (
        <Auth />
      ) : (
        <SignedIn user={user} offline={offline} />
      )}
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
    </BrowserRouter>
  );
}
