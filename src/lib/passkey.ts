import { supabase } from "./supabase";

/**
 * Passkeys exist here for a specific reason: the installed PWA.
 *
 * An app added to the iOS home screen runs in its own storage context. A magic
 * link opened from Mail launches Safari, the session lands there, and the
 * installed app never sees it — so email sign-in cannot get you into the PWA on
 * iOS at all. A passkey completes the whole ceremony inside the app.
 *
 * Supabase gates these behind an experimental flag, set where the client is
 * created.
 */

/** Remembers that this device has a passkey, so sign-in can lead with it. */
const HINT_KEY = "layton:has-passkey";
/** Set when the enrollment prompt is declined, so we ask once, not forever. */
const DISMISS_KEY = "layton:passkey-prompt-dismissed";

export type PasskeyInfo = {
  id: string;
  friendly_name?: string;
  created_at: string;
};

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function"
  );
}

/** True when the browser can offer a platform authenticator (Face ID, Touch ID, Windows Hello). */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function deviceHasPasskeyHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function setPasskeyHint(value: boolean) {
  try {
    if (value) localStorage.setItem(HINT_KEY, "1");
    else localStorage.removeItem(HINT_KEY);
  } catch {
    /* private mode — the hint is only a UI nicety */
  }
}

export function promptDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissPrompt() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

/**
 * A user-cancelled WebAuthn ceremony is not a failure worth shouting about —
 * it is someone pressing Escape. Distinguish it so the UI can stay quiet.
 */
export function isUserCancellation(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    name === "NotAllowedError" ||
    name === "AbortError" ||
    /not allowed|abort|cancel|timed out/i.test(message)
  );
}

/** A readable default name so the passkey list is not a wall of UUIDs. */
function describeThisDevice(): string {
  const ua = navigator.userAgent;
  const platform =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "This device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  return browser ? `${platform} · ${browser}` : platform;
}

/**
 * Register a passkey for the signed-in account.
 * Returns null when the person cancelled; throws only on real failures.
 */
export async function registerPasskey(): Promise<PasskeyInfo | null> {
  const { data, error } = await supabase.auth.registerPasskey();

  if (error) {
    if (isUserCancellation(error)) return null;
    throw error;
  }

  setPasskeyHint(true);

  // Naming is a separate call; a failure here costs nothing but a nicer label.
  if (data?.id) {
    try {
      await supabase.auth.passkey.update({
        passkeyId: data.id,
        friendlyName: describeThisDevice(),
      });
    } catch {
      /* keep the passkey, lose the label */
    }
  }

  return (data as PasskeyInfo) ?? null;
}

/** Sign in with a passkey. Returns false when the person cancelled. */
export async function signInWithPasskey(): Promise<boolean> {
  const { data, error } = await supabase.auth.signInWithPasskey();

  if (error) {
    if (isUserCancellation(error)) return false;
    throw error;
  }

  if (data?.session) {
    setPasskeyHint(true);
    return true;
  }
  return false;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const { data, error } = await supabase.auth.passkey.list();
  if (error) throw error;
  const items = (data ?? []) as PasskeyInfo[];
  setPasskeyHint(items.length > 0);
  return items;
}

export async function deletePasskey(passkeyId: string): Promise<void> {
  const { error } = await supabase.auth.passkey.delete({ passkeyId });
  if (error) throw error;
}
