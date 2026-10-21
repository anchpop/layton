import { createClient } from "@supabase/supabase-js";

// Guaranteed present: the build refuses to start without them (see the
// `layton:require-env` plugin in vite.config.ts). Checking again here would put
// the same invariant in two places and only ever fire after a broken bundle had
// already shipped.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Refuses to query the database as nobody.
 *
 * With no session, supabase-js quietly sends the publishable key in place of a
 * user's token, and row-level security answers that anonymous query with
 * *success and no rows*. Every reader here would take that at its word: no
 * key record means "set up a new master password", no books means an empty
 * shelf, a delete that matched nothing means it worked. A session lapses
 * whenever a refresh is rejected — routinely on a plane — so that answer is
 * not hypothetical. Turning it into an error at the one place every request
 * passes makes the whole class impossible, rather than guarding each caller.
 *
 * Answered with a 401 rather than a rejected fetch: postgrest-js retries a
 * failed fetch with seconds of backoff, which would hold a book's opening on
 * a question that has no answer. The shared-story reader is the single
 * anonymous request, by design.
 */
const signedInFetch: typeof fetch = (input, init) => {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  const bearer = new Headers(init?.headers).get("Authorization");
  if (
    (!bearer || bearer === `Bearer ${key}`) &&
    path.startsWith("/rest/v1/") &&
    path !== "/rest/v1/rpc/shared_book_payload"
  ) {
    return Promise.resolve(
      Response.json(
        {
          code: "signed_out",
          message: "Signed out — sign in to sync. Your writing is on this device.",
        },
        { status: 401 },
      ),
    );
  }
  return fetch(input, init);
};

export const supabase = createClient(url, key, {
  global: { fetch: signedInFetch },
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

/**
 * A frozen, shareable copy of a book. `payload` is the rendered story sealed
 * under a key that exists only in the share link's fragment; `wrapped_key` is
 * that key sealed under the book's key, so the owner can re-show the link.
 * Anonymous readers reach `payload` alone, through shared_book_payload().
 */
export type SharedBookRow = {
  id: string;
  owner_id: string;
  book_id: string;
  payload: string;
  wrapped_key: string;
  created_at: string;
  updated_at: string;
};
