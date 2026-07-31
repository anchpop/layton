import { useState } from "react";
import { Fingerprint } from "lucide-react";

import { dismissPrompt, registerPasskey } from "@/lib/passkey";
import { isIOS } from "@/lib/pwa";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Shown once, right after a first sign-in with no passkey on the account.
 *
 * This is not a generic "improve your security" nag. Without a passkey the
 * installed app is effectively unusable on iOS — a magic link opened from Mail
 * lands in Safari and the home-screen app never receives the session. The copy
 * says so plainly, because that is the actual reason to do it.
 */
export function PasskeySetup({
  email,
  onDone,
}: {
  email: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    setBusy(true);
    setError(null);
    try {
      const created = await registerPasskey();
      if (created) {
        onDone();
        return;
      }
      setBusy(false); // cancelled at the system sheet — no scolding
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Could not create a passkey.",
      );
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <h1 className="font-prose text-2xl tracking-tight">Add a passkey</h1>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          You are signed in as <span className="text-foreground">{email}</span>.
          Adding a passkey now lets you sign in with Face ID, Touch ID, or your
          device lock — no email round trip.
        </p>

        <Card className="mt-4">
          <CardContent className="text-sm leading-relaxed text-muted-foreground">
            {isIOS() ? (
              <>
                <span className="text-foreground">
                  On iPhone and iPad this matters more than usual.
                </span>{" "}
                If you add Layton to your home screen, it runs in its own space.
                A sign-in link from your email opens in Safari, so the installed
                app never receives it. A passkey is the only way in.
              </>
            ) : (
              <>
                <span className="text-foreground">
                  Worth doing before you install the app.
                </span>{" "}
                An installed app has its own session, and an emailed link opens
                in your browser instead. A passkey signs you in inside the app.
              </>
            )}
          </CardContent>
        </Card>

        <Button
          className="mt-6 w-full"
          disabled={busy}
          onClick={() => void onAdd()}
        >
          <Fingerprint className="size-4" />
          {busy ? "Waiting for your device…" : "Add a passkey"}
        </Button>

        <Button
          variant="link"
          className="mt-2 h-auto w-full text-xs text-muted-foreground"
          onClick={() => {
            dismissPrompt();
            onDone();
          }}
        >
          Not now — you can add one later from your library
        </Button>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
