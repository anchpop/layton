import { useState, type FormEvent } from "react";

import { supabase } from "../lib/supabase";

export function Auth() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
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
            <button
              type="button"
              className="mt-3 underline underline-offset-4"
              onClick={() => setSent(false)}
            >
              Use a different address
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-8">
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
              autoFocus
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
              className="mt-4 w-full rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-40"
              style={{ background: "var(--ink)", color: "var(--paper)" }}
            >
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
            {error && (
              <p className="mt-3 text-sm" style={{ color: "#b4483c" }}>
                {error}
              </p>
            )}
            <p className="mt-4 text-xs" style={{ color: "var(--ink-faint)" }}>
              No password. We email you a link that signs you in.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
