import { useState } from "react";
import { Copy, RefreshCw, Share2, X } from "lucide-react";
import { toast } from "sonner";

import type { BookSync } from "@/lib/sync";
import type { ShareLink } from "@/lib/sharePublish";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Sharing a copy of this book, from the same footer where its other standing
 * facts live. Each share is frozen at the moment the link is made: readers get
 * the story as it stands today, and tomorrow's edits stay yours until you cut
 * a new link. The links can be re-shown here later — their keys are kept
 * sealed under the book's own key — and revoked, which deletes the copy.
 */
export function BookSharing({ sync }: { sync: BookSync }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** The link created in this sitting, surfaced above the list. */
  const [fresh, setFresh] = useState<ShareLink | null>(null);
  /** Which link an update is in flight for, so its button can say so. */
  const [updating, setUpdating] = useState<string | null>(null);

  async function load() {
    try {
      setLinks(await sync.listShareLinks());
    } catch {
      // The dialog still works for creating; the list just stays quiet.
      setLinks([]);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      toast.error("Could not reach the clipboard — copy the link by hand.");
    }
  }

  async function create() {
    setBusy(true);
    try {
      const link = await sync.shareCopy();
      setFresh(link);
      setLinks((current) => [link, ...(current ?? [])]);
      await copyLink(link.url);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not share this book.",
      );
    }
    setBusy(false);
  }

  async function update(id: string) {
    setUpdating(id);
    try {
      const updatedAt = await sync.updateShareLink(id);
      setLinks((current) =>
        (current ?? []).map((l) => (l.id === id ? { ...l, updatedAt } : l)),
      );
      toast("Link updated. It now shows the story as it is today.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not update that link.",
      );
    }
    setUpdating(null);
  }

  async function revoke(id: string) {
    try {
      await sync.revokeShareLink(id);
      setLinks((current) => (current ?? []).filter((l) => l.id !== id));
      if (fresh?.id === id) setFresh(null);
      toast("Link revoked. The shared copy is gone.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not revoke that link.",
      );
    }
  }

  const existing = (links ?? []).filter((l) => l.id !== fresh?.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
        else setFresh(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-6 w-fit gap-1.5 px-2 text-[0.7rem] font-normal text-muted-foreground"
        >
          <Share2 className="size-3" />
          Share a copy
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share a copy</DialogTitle>
          <DialogDescription>
            Anyone with the link can view it.
          </DialogDescription>
        </DialogHeader>

        {fresh ? (
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={fresh.url}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 flex-1 text-xs"
              aria-label="Share link"
            />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Copy link"
              onClick={() => void copyLink(fresh.url)}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="w-fit"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? "Sealing…" : "Create sharing link"}
          </Button>
        )}

        {existing.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Shared before</p>
            {existing.map((link) => (
              <div key={link.id} className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {new Date(link.updatedAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Update link to the current story"
                  title="Update to the current story"
                  disabled={updating === link.id}
                  onClick={() => void update(link.id)}
                >
                  <RefreshCw
                    className={
                      updating === link.id ? "size-3.5 animate-spin" : "size-3.5"
                    }
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy link"
                  title="Copy link"
                  onClick={() => void copyLink(link.url)}
                >
                  <Copy className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Revoke link"
                  title="Revoke link"
                  onClick={() => void revoke(link.id)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
