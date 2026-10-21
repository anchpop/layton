export type AuthUser = { id: string; email: string };

/**
 * Who uses this device — remembered across sessions, so that a session lost on
 * a plane does not take the writing with it.
 *
 * Supabase drops a session whenever a refresh is rejected, and on flaky wifi
 * that happens to perfectly healthy accounts: the refresh reaches the server
 * and rotates the token, the reply is lost, and the retry with the old token is
 * refused as reuse. Tying "who is here" to the session would bounce the writer
 * to a sign-in screen they cannot complete offline. So the identity lives here
 * and is forgotten only by an explicit sign-out (vault.signOut).
 *
 * Nothing is trusted to the client by this. It opens ciphertext already on the
 * device, under a key already on the device; the server still demands a real
 * session for every read and write (see signedInFetch in lib/supabase.ts).
 */
const LAST_USER_KEY = "layton:last-user";

export function rememberUser(user: AuthUser): void {
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
  } catch {
    /* private mode */
  }
}

export function recallUser(): AuthUser | null {
  try {
    const user = JSON.parse(localStorage.getItem(LAST_USER_KEY) ?? "null");
    return typeof user?.id === "string" ? user : null;
  } catch {
    return null;
  }
}

export function forgetUser(): void {
  try {
    localStorage.removeItem(LAST_USER_KEY);
  } catch {
    /* private mode */
  }
}
