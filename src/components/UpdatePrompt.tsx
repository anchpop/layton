import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { toast } from "sonner";

/** How often an open tab checks for a new build. */
const UPDATE_POLL_MS = 60 * 60 * 1000;

/**
 * Update handling for the installed app.
 *
 * The service worker fetches new builds automatically, but it does *not* reload
 * the page out from under you. Swapping the bundle mid-sentence would tear down
 * the live ProseMirror view, and while the CRDT would not lose data, you would
 * lose your cursor and scroll position. So a new version waits behind a quiet
 * toast, and you choose the moment.
 */
export function UpdatePrompt() {
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

  useEffect(() => {
    if (!offlineReady) return;
    toast("Ready to write offline.");
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady]);

  useEffect(() => {
    if (!needRefresh) return;
    toast("A new version of Layton is ready.", {
      duration: Infinity,
      action: {
        label: "Reload",
        onClick: () => void updateServiceWorker(true),
      },
      cancel: { label: "Later", onClick: () => {} },
    });
  }, [needRefresh, updateServiceWorker]);

  return null;
}
