import { signOut } from "@/lib/vault";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PasskeyPanel } from "./PasskeyPanel";
import { MasterPasswordPanel } from "./MasterPasswordPanel";

/**
 * Everything about the account, behind your own email address.
 *
 * These are the things you touch once and then not again for a year — keys,
 * passkeys, signing out — so they belong somewhere you go looking rather than
 * stacked beneath the library where they sit under your work every day.
 */
export function AccountDialog({ email }: { email: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-[9rem] justify-start truncate text-muted-foreground sm:max-w-[16rem]"
        >
          {email}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>{email}</DialogDescription>
        </DialogHeader>

        <PasskeyPanel />
        <MasterPasswordPanel />

        <Separator />
        <Button
          variant="ghost"
          size="sm"
          className="w-fit text-muted-foreground"
          onClick={() => void signOut()}
        >
          Sign out
        </Button>
      </DialogContent>
    </Dialog>
  );
}
