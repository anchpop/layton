import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/** How often an open tab checks for a new build. */
const UPDATE_POLL_MS = 60 * 60 * 1000;

/**
 * Update handling for the installed app.
 *
 * The service worker takes new builds automatically, but it does *not* reload
 * the page out from under you. Swapping the bundle mid-sentence would tear down
 * the live ProseMirror view, and while the CRDT would not lose data, you would
 * lose your cursor and scroll position. So a new version waits behind a quiet
 * prompt, and you choose the moment.
 */
export function UpdatePrompt() {
  const [dismissed, setDismissed] = useState(false);

  const {
    needRefresh: [needRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Long-lived tabs are normal for a writing app, so poll rather than rely
      // on a navigation to discover a new build.
      setInterval(() => {
        if (navigator.onLine) void registration.update();
      }, UPDATE_POLL_MS);
    },
  });

  // "Ready to work offline" is reassurance, not an alert — show it briefly.
  useEffect(() => {
    if (!offlineReady) return;
    const id = setTimeout(() => setOfflineReady(false), 5000);
    return () => clearTimeout(id);
  }, [offlineReady, setOfflineReady]);

  const showUpdate = needRefresh && !dismissed;
  if (!showUpdate && !offlineReady) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border px-4 py-3 text-sm shadow-lg"
      style={{
        borderColor: "var(--rule)",
        background: "var(--paper-raised)",
        color: "var(--ink)",
      }}
      role="status"
    >
      {showUpdate ? (
        <div className="flex items-center justify-between gap-4">
          <span>A new version of Layton is ready.</span>
          <span className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              className="rounded-md px-2.5 py-1 text-xs font-medium"
              style={{ background: "var(--ink)", color: "var(--paper)" }}
              onClick={() => void updateServiceWorker(true)}
            >
              Reload
            </button>
            <button
              type="button"
              className="text-xs"
              style={{ color: "var(--ink-faint)" }}
              onClick={() => setDismissed(true)}
            >
              Later
            </button>
          </span>
        </div>
      ) : (
        <span style={{ color: "var(--ink-muted)" }}>
          Ready to write offline.
        </span>
      )}
    </div>
  );
}
