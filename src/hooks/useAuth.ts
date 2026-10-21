import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "../lib/supabase";
import { recallUser, rememberUser, type AuthUser } from "../lib/auth";
import { forgetThisDevice } from "../lib/vault";

export type { AuthUser } from "../lib/auth";

/**
 *   live     a working session
 *   offline  Supabase holds a session it cannot refresh right now; its own
 *            auto-refresh brings it back when the network does
 *   expired  the session is gone (a refresh was refused), but this device
 *            still knows who writes here — the writing stays open and a quiet
 *            "sign in to sync" is offered
 *
 * Writing works in all three; edits queue in the outbox until `live`.
 */
export type SessionStatus = "live" | "offline" | "expired";

export type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  status: SessionStatus;
};

function userOf(session: Session): AuthUser {
  return { id: session.user.id, email: session.user.email ?? "" };
}

export function useAuth(): AuthState {
  // A remembered writer is admitted at once: getSession can sit through
  // several refresh retries on bad wifi, and nothing should stand between an
  // offline writer and their chapter while it does.
  const [auth, setAuth] = useState<AuthState>(() => {
    const user = recallUser();
    return { user, loading: !user, status: "offline" };
  });

  useEffect(() => {
    let cancelled = false;

    function live(session: Session) {
      const user = userOf(session);
      rememberUser(user);
      setAuth({ user, loading: false, status: "live" });
    }

    /** No session. Whether that is a sign-out is the remembered user's call. */
    function lost(status: SessionStatus) {
      const user = recallUser();
      setAuth({ user, loading: false, status });
    }

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (data.session) live(data.session);
        // An error means the stored session is still there, unrefreshed.
        else lost(error ? "offline" : "expired");
      })
      .catch(() => {
        if (!cancelled) lost("offline");
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) live(session);
      else if (event === "SIGNED_OUT") {
        // vault.signOut forgets the user before ending the session, in
        // whichever tab it ran (localStorage is shared). If the user is still
        // remembered, nobody asked for this: Supabase dropped a session it
        // could not refresh, and the device key stays where it is.
        if (!recallUser()) void forgetThisDevice();
        lost("expired");
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return auth;
}
