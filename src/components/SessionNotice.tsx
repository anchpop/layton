import { useState } from "react";
import { Auth } from "./Auth";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/** Reauthentication is optional: the editor stays mounted behind the dialog. */
export function SessionNotice() {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-3 text-xs text-muted-foreground">
      <Button
        variant="link"
        className="h-auto p-0 text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Signed out — sign in to sync
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in to sync</DialogTitle>
            <DialogDescription>
              Your writing stays on this device. Sign in to send it to your
              other devices.
            </DialogDescription>
          </DialogHeader>
          <Auth embedded redirectTo={window.location.href} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
