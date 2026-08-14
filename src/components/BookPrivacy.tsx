import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";

import type { BookSync } from "@/lib/sync";
import { useVaultStatus } from "@/hooks/useVault";
import { Button } from "@/components/ui/button";
import { UnlockPrivate } from "./UnlockPrivate";

/**
 * Whether this book is private, shown and changed where the book is.
 *
 * It sits at the foot of the panel with the word count and the sync badge —
 * the standing facts about this book, rather than anything to do while
 * writing. The library's context menu still offers the same move for when you
 * are looking at all of them at once.
 *
 * Asking for the master password is folded into the same gesture. Making a
 * book private needs the private key, and requiring someone to find the
 * padlock in the library, unlock there, come back, and only then be offered
 * this would be three steps for one intention.
 */
export function BookPrivacy({
  sync,
  isPrivate,
}: {
  sync: BookSync;
  isPrivate: boolean;
}) {
  const { privateUnlocked } = useVaultStatus();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function move(next: boolean) {
    setBusy(true);
    try {
      await sync.setPrivate(next);
      toast(
        next
          ? "Private. This book disappears when you lock."
          : "This book is ordinary again.",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not move that book.",
      );
    }
    setBusy(false);
  }

  if (asking && !privateUnlocked) {
    return (
      <div className="pb-1">
        <p className="mb-2 text-xs text-muted-foreground">
          Your master password, to make this book private.
        </p>
        <UnlockPrivate
          onDone={() => {
            setAsking(false);
            void move(true);
          }}
          onCancel={() => setAsking(false)}
        />
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      className="-ml-2 h-6 w-fit gap-1.5 px-2 text-[0.7rem] font-normal text-muted-foreground"
      onClick={() => {
        if (isPrivate) void move(false);
        else if (privateUnlocked) void move(true);
        else setAsking(true);
      }}
    >
      {isPrivate ? (
        <>
          <Lock className="size-3" />
          Private
        </>
      ) : (
        <>
          <LockOpen className="size-3" />
          Make private
        </>
      )}
    </Button>
  );
}
