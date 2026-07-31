import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "../lib/supabase";

export type AuthUser = { id: string; email: string };

export type AuthState = {
  user: AuthUser | null;
  session: Session | null;
  loading: boolean;
  /**
   * True when we are showing the app from a remembered sign-in because the auth
   * server could not be reached. Writing works; it queues in the outbox.
   */
  offline: boolean;
};

/**
 * Remembers who was last signed in on this device.
 *
 * Supabase deliberately treats a session whose access token has *actually*
 * expired as dead when the refresh call fails. That is the right call for a
 * normal web app and the wrong one here: open the installed app on a plane a
 * day later and you would be bounced to a sign-in screen you cannot complete,
 * with a finished chapter sitting in IndexedDB behind it.
 *
 * So when — and only when — the refresh fails for network reasons, we fall back
 * to the remembered identity and keep writing. Nothing is trusted to the
 * client by doing this: every read and write still has to satisfy row-level
 * security on the server once the connection returns, and until then edits
 * simply queue locally.
 */
const LAST_USER_KEY = "layton:last-user";

function rememberUser(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(LAST_USER_KEY);
  } catch {
    /* private mode */
  }
}

function recallUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

/** A failure we should ride out rather than sign the person out over. */
function looksLikeNetworkFailure(error: unknown): boolean {
  if (!navigator.onLine) return true;
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "AuthRetryableFetchError" ||
    /fetch|network|timeout|failed to fetch/i.test(message)
  );
}

function toAuthUser(session: Session): AuthUser {
  return { id: session.user.id, email: session.user.email ?? "" };
}

export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;

        if (data.session) {
          const next = toAuthUser(data.session);
          rememberUser(next);
          setSession(data.session);
          setUser(next);
          setOffline(false);
        } else {
          const remembered = recallUser();
          if (remembered && looksLikeNetworkFailure(error)) {
            setUser(remembered);
            setOffline(true);
          } else {
            // A real sign-out or an genuinely invalid session.
            if (!looksLikeNetworkFailure(error)) rememberUser(null);
            setUser(null);
            setOffline(false);
          }
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        const remembered = recallUser();
        setUser(remembered);
        setOffline(remembered != null);
        setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (next) {
        const authUser = toAuthUser(next);
        rememberUser(authUser);
        setSession(next);
        setUser(authUser);
        setOffline(false);
      } else if (event === "SIGNED_OUT") {
        rememberUser(null);
        setSession(null);
        setUser(null);
        setOffline(false);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { user, session, loading, offline };
}
