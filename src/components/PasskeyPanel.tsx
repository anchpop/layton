import { useEffect, useState } from "react";
import { ChevronDown, Fingerprint } from "lucide-react";

import {
  deletePasskey,
  isPasskeySupported,
  listPasskeys,
  registerPasskey,
  type PasskeyInfo,
} from "@/lib/passkey";
import { isIOS, isStandalone } from "@/lib/pwa";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Passkey management, tucked below the library.
 *
 * Collapsed by default — most of the time you are here to write, not to
 * administer credentials. It opens itself when the account has none and the
 * app is installed, because that combination is the one that locks you out.
 */
export function PasskeyPanel() {
  const supported = isPasskeySupported();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<PasskeyInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    listPasskeys()
      .then((items) => {
        setKeys(items);
        if (items.length === 0 && isStandalone()) setOpen(true);
      })
      .catch(() => setKeys([]));
  }, [supported]);

  if (!supported) return null;

  async function onAdd() {
    setBusy(true);
    setError(null);
    try {
      const created = await registerPasskey();
      if (created) setKeys(await listPasskeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add a passkey.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deletePasskey(id);
      setKeys(await listPasskeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove it.");
    } finally {
      setBusy(false);
    }
  }

  const count = keys?.length ?? 0;

  return (
    <section className="mt-16">
      <Separator />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 py-4 text-left"
      >
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Sign-in &amp; devices
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {count === 0 ? "No passkeys" : `${count} passkey${count === 1 ? "" : "s"}`}
          <ChevronDown
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div className="pb-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            A passkey signs you in with Face ID, Touch ID, or your device lock.
            {isIOS() && (
              <>
                {" "}
                It is also the only way in once Layton is on your home screen —
                an emailed link opens in Safari, which the installed app cannot
                see.
              </>
            )}
          </p>

          {count > 0 && (
            <ul className="mt-4">
              {keys?.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center justify-between gap-4 border-b py-2.5 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {key.friendly_name || "Passkey"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Added{" "}
                      {new Date(key.created_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    className="shrink-0 text-xs text-muted-foreground"
                    onClick={() => void onRemove(key.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            disabled={busy}
            onClick={() => void onAdd()}
          >
            <Fingerprint className="size-4" />
            {busy ? "Waiting for your device…" : "Add a passkey for this device"}
          </Button>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
