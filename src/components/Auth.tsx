import { useEffect, useState, type FormEvent } from "react";
import { Fingerprint, Mail } from "lucide-react";

import { supabase } from "@/lib/supabase";
import {
  deviceHasPasskeyHint,
  isPasskeySupported,
  signInWithPasskey,
} from "@/lib/passkey";
import { isStandalone } from "@/lib/pwa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export function Auth({ redirectTo = window.location.origin }: { redirectTo?: string }) {
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
  // and keep email behind a disclosure.
  useEffect(() => {
    if (!passkeySupported || (!knownDevice && !installed)) setShowEmail(true);
  }, [passkeySupported, knownDevice, installed]);

  async function onEmailSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo },
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
      if (!ok) setPasskeyBusy(false); // dismissed the sheet — say nothing
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
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <h1 className="font-prose text-3xl tracking-tight">Layton</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A quiet place to write, on every device you own.
        </p>

        {sent ? (
          <div className="mt-8 rounded-lg border p-4 text-sm text-muted-foreground">
            <p className="text-foreground">Check your email.</p>
            <p className="mt-1">
              We sent a sign-in link to{" "}
              <span className="text-foreground">{email}</span>. Open it on this
              device to continue.
            </p>
            {installed && (
              <p className="mt-2">
                Opening it will land you in your browser rather than here. Sign
                in there once, add a passkey, then come back — after that this
                app signs you in directly.
              </p>
            )}
            <Button
              variant="link"
              className="mt-2 h-auto p-0"
              onClick={() => setSent(false)}
            >
              Use a different address
            </Button>
          </div>
        ) : (
          <div className="mt-8">
            {passkeySupported && (
              <>
                <Button
                  className="w-full"
                  disabled={passkeyBusy}
                  onClick={() => void onPasskey()}
                >
                  <Fingerprint className="size-4" />
                  {passkeyBusy ? "Waiting…" : "Sign in with a passkey"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  Uses Face ID, Touch ID, or your device lock.
                </p>
              </>
            )}

            {passkeySupported && !showEmail && (
              <Button
                variant="link"
                className="mt-4 h-auto p-0 text-xs text-muted-foreground"
                onClick={() => setShowEmail(true)}
              >
                First time here? Sign in with email
              </Button>
            )}

            {showEmail && (
              <form onSubmit={onEmailSubmit}>
                {passkeySupported && <Separator className="my-6" />}
                <Label
                  htmlFor="email"
                  className="text-xs uppercase tracking-widest text-muted-foreground"
                >
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-2"
                />
                <Button
                  type="submit"
                  variant={passkeySupported ? "outline" : "default"}
                  className="mt-3 w-full"
                  disabled={busy || email.trim().length === 0}
                >
                  <Mail className="size-4" />
                  {busy ? "Sending…" : "Send sign-in link"}
                </Button>
              </form>
            )}

            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          </div>
        )}

        <footer className="mt-8 border-t pt-4 text-xs text-muted-foreground">
          <a
            href="https://github.com/anchpop/layton"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            GitHub
          </a>
        </footer>
      </div>
    </div>
  );
}
