import { createClient } from "@supabase/supabase-js";

// Guaranteed present: the build refuses to start without them (see the
// `layton:require-env` plugin in vite.config.ts). Checking again here would put
// the same invariant in two places and only ever fire after a broken bundle had
// already shipped.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Passkey APIs are opt-in and throw a descriptive error if called without
    // this. They are what let the installed PWA sign in at all on iOS, where a
    // magic link opened in Safari can never reach the home-screen app.
    experimental: { passkey: true },
  },
  realtime: {
    params: { eventsPerSecond: 20 },
  },
});

/**
 * `title_cipher` and `payload` are sealed envelopes, and `wrapped_key` is the
 * book's key sealed under one of the account keys. Nothing the server holds is
 * readable without a master password it never receives — see lib/vault.ts.
 */
export type BookRow = {
  id: string;
  owner_id: string;
  title_cipher: string;
  wrapped_key: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type BookUpdateRow = {
  id: number;
  book_id: string;
  owner_id: string;
  kind: "update" | "snapshot";
  payload: string;
  created_at: string;
};
