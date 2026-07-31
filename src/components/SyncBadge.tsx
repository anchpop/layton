import type { SyncState } from "@/lib/sync";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Deliberately understated. While writing you want to know that your words are
 * safe, not to be interrupted by a status widget — so the calm state is a small
 * dot and a single word, with the detail on hover.
 */
export function SyncBadge({ state }: { state: SyncState }) {
  const view = describe(state);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-default items-center gap-1.5">
          <span
            aria-hidden
            className={cn("inline-block size-1.5 rounded-full", view.dot)}
          />
          <span>{view.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{view.detail}</TooltipContent>
    </Tooltip>
  );
}

function describe(state: SyncState): {
  label: string;
  dot: string;
  detail: string;
} {
  if (state.status === "loading") {
    return { label: "Opening", dot: "bg-muted-foreground", detail: "Loading" };
  }
  if (state.status === "offline") {
    return {
      label: "Offline",
      dot: "bg-amber-500",
      detail:
        state.pending > 0
          ? `${state.pending} change${state.pending === 1 ? "" : "s"} saved on this device, waiting to sync`
          : "Working offline — your writing is saved on this device",
    };
  }
  if (state.status === "error") {
    return {
      label: "Retrying",
      dot: "bg-destructive",
      detail: state.error ?? "Could not reach the server; will retry",
    };
  }
  if (state.status === "syncing" || state.pending > 0) {
    return {
      label: "Saving",
      dot: "bg-ring",
      detail: `${state.pending} change${state.pending === 1 ? "" : "s"} in flight`,
    };
  }
  return {
    label: "Synced",
    dot: "bg-emerald-600",
    detail: "Everything is saved to your account",
  };
}
