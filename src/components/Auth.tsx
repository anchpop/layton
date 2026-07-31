import { useEffect, useState, type FormEvent } from "react";

import { supabase } from "../lib/supabase";
import {
  deviceHasPasskeyHint,
  isPasskeySupported,
  signInWithPasskey,
} from "../lib/passkey";
import { isStandalone } from "../lib/pwa";

export function Auth() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmail, setShowEmail] = useState(false);

  const passkeySupported = isPasskeySupported();
  const knownDevice = deviceHasPasskeyHint();
  const installed = isStandalone();

  // Inside an installed app, email is a dead end on iOS: the link opens in the
  // browser and the session never reaches this context. Lead with the passkey
  // and keep email tucked behind a disclosure.
  useEffect(() => {
    if (!passkeySupported || (!knownDevice && !installed)) setShowEmail(true);
  }, [passkeySupported, knownDevice, installed]);

  async function onEmailSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (err) setError(err.message);
    else setSent(true);
  }

  async function onPasskey() {
    setPasskeyBusy(true);
    setError(null);
    try {
      const ok = await signInWithPasskey();
      // `false` means the sheet was dismissed — say nothing.
      if (!ok) setPasskeyBusy(false);
      // On success the auth listener swaps this screen out.
    } catch (err) {
      setPasskeyBusy(false);
      setError(
        err instanceof Error
          ? `${err.message}. If you have not set up a passkey yet, sign in with email first.`
          : "Could not sign in with a passkey.",
      );
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1
          className="text-3xl tracking-tight"
          style={{ fontFamily: "var(--font-prose)" }}
        >
          Layton
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--ink-muted)" }}>
          A quiet place to write, on every device you own.
        </p>

        {sent ? (
          <div
            className="mt-8 rounded-lg border p-4 text-sm"
            style={{ borderColor: "var(--rule)", color: "var(--ink-muted)" }}
          >
            <p style={{ color: "var(--ink)" }}>Check your email.</p>
            <p className="mt-1">
              We sent a sign-in link to{" "}
              <span style={{ color: "var(--ink)" }}>{email}</span>. Open it on
              this device to continue.
            </p>
            {installed && (
              <p className="mt-2">
                Opening it will land you in your browser rather than here. Sign
                in there once, add a passkey, then come back — after that this
                app signs you in directly.
              </p>
            )}
            <button
              type="button"
              className="mt-3 underline underline-offset-4"
              onClick={() => setSent(false)}
            >
              Use a different address
            </button>
          </div>
        ) : (
          <div className="mt-8">
            {passkeySupported && (
              <>
                <button
                  type="button"
                  onClick={() => void onPasskey()}
                  disabled={passkeyBusy}
                  className="w-full rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-40"
                  style={{ background: "var(--ink)", color: "var(--paper)" }}
                >
                  {passkeyBusy ? "Waiting…" : "Sign in with a passkey"}
                </button>
                <p
                  className="mt-2 text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                  Uses Face ID, Touch ID, or your device lock.
                </p>
              </>
            )}

            {passkeySupported && !showEmail && (
              <button
                type="button"
                onClick={() => setShowEmail(true)}
                className="mt-5 text-xs underline underline-offset-4"
                style={{ color: "var(--ink-muted)" }}
              >
                First time here? Sign in with email
              </button>
            )}

            {showEmail && (
              <form
                onSubmit={onEmailSubmit}
                className={passkeySupported ? "mt-6 border-t pt-6" : ""}
                style={
                  passkeySupported ? { borderColor: "var(--rule)" } : undefined
                }
              >
                <label
                  htmlFor="email"
                  className="block text-xs uppercase tracking-widest"
                  style={{ color: "var(--ink-faint)" }}
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-2 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-current"
                  style={{ borderColor: "var(--rule)", color: "var(--ink)" }}
                />
                <button
                  type="submit"
                  disabled={busy || email.trim().length === 0}
                  className="mt-3 w-full rounded-md border px-3 py-2 text-sm font-medium transition disabled:opacity-40"
                  style={{
                    borderColor: "var(--rule)",
                    color: "var(--ink)",
                    background: passkeySupported
                      ? "transparent"
                      : "var(--ink)",
                    ...(passkeySupported ? {} : { color: "var(--paper)" }),
                  }}
                >
                  {busy ? "Sending…" : "Send sign-in link"}
                </button>
                <p
                  className="mt-3 text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                  No password. We email you a link that signs you in.
                </p>
              </form>
            )}

            {error && (
              <p className="mt-4 text-sm" style={{ color: "#b4483c" }}>
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
