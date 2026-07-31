import type { SyncState } from "../lib/sync";

/**
 * Deliberately understated. While writing you want to know that your words are
 * safe, not to be interrupted by a status widget — so the calm state is a small
 * dot and a single word.
 */
export function SyncBadge({ state }: { state: SyncState }) {
  const view = describe(state);
  return (
    <span className="flex items-center gap-1.5" title={view.detail}>
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: view.color }}
      />
      <span>{view.label}</span>
    </span>
  );
}

function describe(state: SyncState): {
  label: string;
  color: string;
  detail: string;
} {
  if (state.status === "loading") {
    return { label: "Opening", color: "var(--ink-faint)", detail: "Loading" };
  }
  if (state.status === "offline") {
    return {
      label: "Offline",
      color: "#c08a3e",
      detail:
        state.pending > 0
          ? `${state.pending} change${state.pending === 1 ? "" : "s"} saved on this device, waiting to sync`
          : "Working offline — your writing is saved on this device",
    };
  }
  if (state.status === "error") {
    return {
      label: "Retrying",
      color: "#b4483c",
      detail: state.error ?? "Could not reach the server; will retry",
    };
  }
  if (state.status === "syncing" || state.pending > 0) {
    return {
      label: "Saving",
      color: "var(--accent)",
      detail: `${state.pending} change${state.pending === 1 ? "" : "s"} in flight`,
    };
  }
  return {
    label: "Synced",
    color: "#5c8a5c",
    detail: "Everything is saved to your account",
  };
}
