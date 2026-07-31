import { Component, type ReactNode } from "react";

/**
 * Recovers from a stale deploy.
 *
 * When a new version ships, the hashed chunk filenames change. A tab holding
 * the previous index.html will ask for a chunk that no longer exists, the lazy
 * import rejects, and the Suspense boundary never resolves — a blank page.
 *
 * A single automatic reload fetches the new index.html and fixes it. The
 * sessionStorage guard means a genuinely broken build shows an error instead of
 * reloading forever.
 */

const RELOAD_FLAG = "layton:chunk-reloaded";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ChunkBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isChunkError =
      /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
        message,
      );

    if (isChunkError && !sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
      return;
    }
    console.error("Layton failed to load", error);
  }

  componentDidMount() {
    // A clean mount means the app is healthy; allow a future auto-reload.
    sessionStorage.removeItem(RELOAD_FLAG);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center px-6">
          <div className="text-center">
            <p style={{ fontFamily: "var(--font-prose)", fontSize: "1.05rem" }}>
              Something went wrong loading the editor.
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--ink-muted)" }}>
              Your writing is safe — it is stored on this device and in your
              account.
            </p>
            <button
              type="button"
              className="mt-4 rounded-md px-3 py-1.5 text-sm font-medium"
              style={{ background: "var(--ink)", color: "var(--paper)" }}
              onClick={() => {
                sessionStorage.removeItem(RELOAD_FLAG);
                window.location.reload();
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
