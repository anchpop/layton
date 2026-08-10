import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";

import { eraseEverything, signOut, unlockDevice } from "@/lib/vault";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/**
 * A device that has not been taught the everyday key yet — a new phone, a fresh
 * browser, or this one after signing out.
 *
 * Unlocking here hands over the everyday key only. Private books stay hidden
 * until they are asked for by name, so signing in on a borrowed machine cannot
 * put them on screen as a side effect.
 */
export function VaultUnlock({
  userId,
  email,
  onErased,
}: {
  userId: string;
  email: string;
  onErased: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlockDevice(userId, passphrase);
      // The gate follows the vault; there is nothing to navigate to.
    } catch (err) {
      setBusy(false);
      setPassphrase("");
      setError(err instanceof Error ? err.message : "Could not unlock.");
    }
  }

  async function onErase() {
    setErasing(true);
    setError(null);
    try {
      await eraseEverything(userId);
      // Erasing hands over no key, so the vault has nothing to announce and the
      // gate would sit here asking for a password to books that are gone.
      onErased();
    } catch (err) {
      setErasing(false);
      setError(
        err instanceof Error ? err.message : "Could not erase this account.",
      );
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <h1 className="font-prose text-2xl tracking-tight">Unlock Layton</h1>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Your books are encrypted. Type the master password to teach this
          device the key — once only; after this it opens on its own, offline
          included.
        </p>

        <form onSubmit={onSubmit} className="mt-6">
          <Label
            htmlFor="unlock"
            className="text-xs uppercase tracking-widest text-muted-foreground"
          >
            Master password
          </Label>
          <Input
            id="unlock"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="mt-2"
          />
          <Button
            type="submit"
            className="mt-4 w-full"
            disabled={busy || passphrase.length === 0}
          >
            <KeyRound className="size-4" />
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </form>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        <p className="mt-8 text-xs text-muted-foreground">
          Signed in as {email}.{" "}
          <Button
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </p>

        {/* The only exit from a forgotten password, and it is not a way back
            in — it is a way to start again. Behind a confirmation because it
            cannot be undone by anyone, including us. */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="link"
              className="mt-1 h-auto p-0 text-xs text-muted-foreground"
            >
              I have forgotten it
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Erase everything?</AlertDialogTitle>
              <AlertDialogDescription>
                There is no recovery key, so a forgotten master password cannot
                be worked around — every book on this account is permanently
                unreadable. This deletes them all and lets you choose a new
                password with an empty library. It cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep trying</AlertDialogCancel>
              <AlertDialogAction
                disabled={erasing}
                onClick={() => void onErase()}
              >
                {erasing ? "Erasing…" : "Erase everything"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
