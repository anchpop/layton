import { useState } from "react";

import { dismissPrompt, registerPasskey } from "../lib/passkey";
import { isIOS } from "../lib/pwa";

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
      // Cancelled at the system sheet — stay put, no scolding.
      setBusy(false);
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Could not create a passkey.",
      );
    }
  }

  function onSkip() {
    dismissPrompt();
    onDone();
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1
          className="text-2xl tracking-tight"
          style={{ fontFamily: "var(--font-prose)" }}
        >
          Add a passkey
        </h1>

        <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--ink-muted)" }}>
          You are signed in as{" "}
          <span style={{ color: "var(--ink)" }}>{email}</span>. Adding a passkey
          now lets you sign in with Face ID, Touch ID, or your device lock —
          no email round trip.
        </p>

        <div
          className="mt-4 rounded-lg border p-4 text-sm leading-relaxed"
          style={{ borderColor: "var(--rule)", color: "var(--ink-muted)" }}
        >
          {isIOS() ? (
            <>
              <span style={{ color: "var(--ink)" }}>
                On iPhone and iPad this matters more than usual.
              </span>{" "}
              If you add Layton to your home screen, it runs in its own space.
              A sign-in link from your email opens in Safari, so the installed
              app never receives it. A passkey is the only way in.
            </>
          ) : (
            <>
              <span style={{ color: "var(--ink)" }}>
                Worth doing before you install the app.
              </span>{" "}
              An installed app has its own session, and an emailed link opens in
              your browser instead. A passkey signs you in inside the app.
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={busy}
          className="mt-6 w-full rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-40"
          style={{ background: "var(--ink)", color: "var(--paper)" }}
        >
          {busy ? "Waiting for your device…" : "Add a passkey"}
        </button>

        <button
          type="button"
          onClick={onSkip}
          className="mt-3 w-full text-xs underline underline-offset-4"
          style={{ color: "var(--ink-faint)" }}
        >
          Not now — you can add one later from your library
        </button>

        {error && (
          <p className="mt-4 text-sm" style={{ color: "#b4483c" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
