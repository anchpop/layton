import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";

import { createVault } from "@/lib/vault";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Short enough to type often, long enough to be worth the 600,000 rounds. */
const MIN_LENGTH = 10;

/**
 * Shown once per account, before there is anything to lose.
 *
 * The warning is not boilerplate. There is no recovery key and no reset,
 * because either would mean a copy of the key existing somewhere this password
 * does not reach — which is the property that makes the encryption worth
 * having. The honest version of that is a sentence saying the books are gone,
 * and a box the writer has to tick.
 */
export function VaultSetup({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready =
    passphrase.length >= MIN_LENGTH && confirm === passphrase && understood;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await createVault(userId, passphrase);
      // No navigation: the vault announces itself and the gate opens.
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Could not set up encryption.",
      );
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <h1 className="font-prose text-2xl tracking-tight">
          Choose a master password
        </h1>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Everything you write is encrypted on this device before it is sent
          anywhere. This password is what unlocks it, and{" "}
          <span className="text-foreground">
            it never leaves your browser
          </span>{" "}
          — not to Layton, not to the server holding your books.
        </p>

        <div className="mt-6">
          <Label
            htmlFor="master"
            className="text-xs uppercase tracking-widest text-muted-foreground"
          >
            Master password
          </Label>
          <Input
            id="master"
            type="password"
            required
            autoFocus
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="mt-2"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {tooShort
              ? `At least ${MIN_LENGTH} characters.`
              : "A phrase you will still remember in a year is worth more than a clever one you will not."}
          </p>
        </div>

        <div className="mt-4">
          <Label
            htmlFor="master-confirm"
            className="text-xs uppercase tracking-widest text-muted-foreground"
          >
            Again
          </Label>
          <Input
            id="master-confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2"
          />
          {mismatch && (
            <p className="mt-2 text-xs text-destructive">
              These do not match yet.
            </p>
          )}
        </div>

        <Card className="mt-6">
          <CardContent className="text-sm leading-relaxed text-muted-foreground">
            <span className="text-foreground">
              If you forget it, your books are gone.
            </span>{" "}
            Nobody can reset it and no support request can recover it.
            <label className="mt-4 flex items-start gap-2.5 text-foreground">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span>I understand there is no way to recover it.</span>
            </label>
          </CardContent>
        </Card>

        <Button type="submit" className="mt-6 w-full" disabled={!ready || busy}>
          <KeyRound className="size-4" />
          {busy ? "Setting up…" : "Encrypt my writing"}
        </Button>

        <p className="mt-3 text-xs text-muted-foreground">
          Signed in as {email}.
        </p>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      </form>
    </div>
  );
}
