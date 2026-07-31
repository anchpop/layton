import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local and fill it in.",
  );
}

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

export type BookRow = {
  id: string;
  owner_id: string;
  title: string;
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
