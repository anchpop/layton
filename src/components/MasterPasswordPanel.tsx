import { useState, type FormEvent } from "react";
import { ChevronDown, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { changePassphrase } from "@/lib/vault";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Matches the minimum the setup screen enforces. */
const MIN_LENGTH = 10;

/**
 * Changing the master password, inside the account dialog.
 *
 * Collapsed by default: a once-a-year act does not need to greet you. The one
 * line of copy is there because "changed my password" means different things
 * to someone strengthening one and someone who has just lost a laptop, and
 * only the second of those is disappointed by what this does.
 */
export function MasterPasswordPanel() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    current.length > 0 && next.length >= MIN_LENGTH && confirm === next;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await changePassphrase(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setOpen(false);
      toast("Master password changed. Your other devices keep working.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not change the password.",
      );
    }
    setBusy(false);
  }

  return (
    <section>
      <Separator />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 py-4 text-left"
      >
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Master password
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          Change
          <ChevronDown
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <form onSubmit={onSubmit} className="pb-6">
          <p className="mb-5 text-xs text-muted-foreground">
            Applies on every device. Devices already unlocked stay unlocked.
          </p>

          <Label
            htmlFor="mp-current"
            className="text-xs uppercase tracking-widest text-muted-foreground"
          >
            Current password
          </Label>
          <Input
            id="mp-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="mb-4 mt-2"
          />

          <Label
            htmlFor="mp-next"
            className="text-xs uppercase tracking-widest text-muted-foreground"
          >
            New password
          </Label>
          <Input
            id="mp-next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="mb-4 mt-2"
          />
          {next.length > 0 && next.length < MIN_LENGTH && (
            <p className="mt-2 text-xs text-muted-foreground">
              At least {MIN_LENGTH} characters.
            </p>
          )}

          <Label
            htmlFor="mp-confirm"
            className="text-xs uppercase tracking-widest text-muted-foreground"
          >
            Again
          </Label>
          <Input
            id="mp-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2"
          />
          {confirm.length > 0 && confirm !== next && (
            <p className="mt-2 text-xs text-destructive">
              These do not match yet.
            </p>
          )}

          <Button type="submit" className="mt-5" disabled={!ready || busy}>
            <KeyRound className="size-4" />
            {busy ? "Changing…" : "Change password"}
          </Button>

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        </form>
      )}
    </section>
  );
}
