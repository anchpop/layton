import { useState, type FormEvent } from "react";

import { unlockPrivate } from "@/lib/vault";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The same master password again, this time for the key that is never kept.
 *
 * Used in two places — revealing private books in the library, and opening a
 * private book whose page is sitting there locked — because they are the same
 * act. Both hand the key back for as long as the writing continues.
 */
export function UnlockPrivate({
  onDone,
  onCancel,
  className,
}: {
  onDone?: () => void;
  onCancel?: () => void;
  className?: string;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlockPrivate(passphrase);
      setPassphrase("");
      setBusy(false);
      onDone?.();
    } catch (err) {
      setBusy(false);
      setPassphrase("");
      setError(err instanceof Error ? err.message : "Could not unlock.");
    }
  }

  return (
    <form onSubmit={onSubmit} className={cn("w-full", className)}>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="Master password"
          aria-label="Master password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel?.();
          }}
        />
        <Button type="submit" disabled={busy || passphrase.length === 0}>
          {busy ? "…" : "Unlock"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  );
}
