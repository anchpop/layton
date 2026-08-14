import { supabase } from "./supabase";
import { base64ToBytes, bytesToBase64 } from "./bytes";
import {
  KDF_ITERATIONS,
  deriveMasterKey,
  importContentKey,
  randomKeyBytes,
  randomSalt,
  seal,
  tryUnseal,
  unseal,
} from "./crypto";
import {
  deleteLocalBook,
  forgetDeviceKey,
  forgetVaultRecord,
  updateLocalWrappedKey,
  loadDeviceKey,
  loadVaultRecord,
  saveDeviceKey,
  saveVaultRecord,
  type VaultRecord,
} from "./localStore";

/**
 * Which keys this browser is currently holding, and what that means on screen.
 *
 * There are two, both random, both sealed under the same master password:
 *
 *   everyday key   Kept on the device as a non-extractable CryptoKey. Unwraps
 *                  ordinary books. Survives restarts, so writing needs no
 *                  password after the first time — the offline-first promise
 *                  would be a lie otherwise.
 *
 *   private key    Never written down anywhere. Lives in this module and dies
 *                  with the tab, the idle timer, or the lock button. Unwraps
 *                  private books.
 *
 * A book does not record which of the two it belongs to. Its key is sealed
 * under one of them, and the way to find out which is to try. That is the whole
 * concealment mechanism: with the private key gone, a private book is a row
 * that will not open, and a row that will not open is not rendered. There is
 * no flag to leak, no count to redact, and no code path where forgetting a
 * conditional would put a private title on screen.
 *
 * Signing in does NOT hand over the private key, even though the same password
 * would unwrap it. Revealing private books is always a separate, deliberate act
 * — so "I am signed in" and "my private books are visible" never blur into one
 * state, and the lock button has an unambiguous meaning.
 */

/** Inactivity after which the private key is dropped. */
export const IDLE_LIMIT_MS = 15 * 60_000;
/**
 * How often idleness is checked. The check compares wall-clock timestamps
 * rather than trusting a timer to have fired on schedule, because a background
 * tab's timers are throttled and a suspended laptop's stop entirely — either
 * would otherwise hand out an unlock far longer than it was asked for.
 */
const IDLE_CHECK_MS = 30_000;

const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export class WrongPassphraseError extends Error {
  constructor() {
    super("That master password does not match.");
    this.name = "WrongPassphraseError";
  }
}

export type VaultStatus = {
  /** The everyday key is in hand: ordinary books can be read and written. */
  unlocked: boolean;
  /** The private key is in hand: private books are visible. */
  privateUnlocked: boolean;
};

export type VaultLookup =
  | { kind: "found"; record: VaultRecord }
  /** Definitively no vault yet — this account has never set a master password. */
  | { kind: "absent" }
  /** Could not find out. Never treat this as "absent"; it would offer to
   *  create a second vault over the top of a perfectly good one. */
  | { kind: "unavailable" };

let currentUserId: string | null = null;
let everydayKey: CryptoKey | null = null;
let privateKey: CryptoKey | null = null;

const listeners = new Set<(status: VaultStatus) => void>();

export function status(): VaultStatus {
  return { unlocked: everydayKey != null, privateUnlocked: privateKey != null };
}

export function subscribe(listener: (status: VaultStatus) => void): () => void {
  listeners.add(listener);
  listener(status());
  return () => listeners.delete(listener);
}

function announce() {
  const current = status();
  for (const listener of listeners) listener(current);
}

// ---------------------------------------------------------------------------
// The sealed key record
// ---------------------------------------------------------------------------

/**
 * The account's key record, from the server when it can be reached and from
 * the local copy when it cannot.
 *
 * Caching it locally is what lets a device unlock on a plane. The copy is worth
 * nothing without the password: it is two sealed envelopes and the KDF
 * parameters needed to attack them, which is exactly what the server already
 * holds.
 */
export async function lookupVault(userId: string): Promise<VaultLookup> {
  const { data, error } = await supabase
    .from("user_keys")
    .select("salt,iterations,wrapped_key,wrapped_private_key")
    .eq("user_id", userId)
    .maybeSingle();

  if (!error) {
    if (!data) return { kind: "absent" };
    const record: VaultRecord = {
      userId,
      salt: data.salt as string,
      iterations: data.iterations as number,
      wrappedKey: data.wrapped_key as string,
      wrappedPrivateKey: data.wrapped_private_key as string,
    };
    await saveVaultRecord(record);
    return { kind: "found", record };
  }

  const cached = await loadVaultRecord(userId);
  return cached ? { kind: "found", record: cached } : { kind: "unavailable" };
}

/**
 * The account keys as raw bytes. Only two callers can want these: importing
 * them into non-extractable CryptoKeys, and re-sealing them under a new
 * password. Everything else takes the CryptoKeys.
 */
async function unwrapRaw(
  record: VaultRecord,
  passphrase: string,
): Promise<{ everydayRaw: Uint8Array; secretRaw: Uint8Array }> {
  const masterKey = await deriveMasterKey(
    passphrase,
    base64ToBytes(record.salt),
    record.iterations,
  );

  const everydayRaw = await tryUnseal(
    masterKey,
    base64ToBytes(record.wrappedKey),
  );
  if (!everydayRaw) throw new WrongPassphraseError();
  const secretRaw = await unseal(
    masterKey,
    base64ToBytes(record.wrappedPrivateKey),
  );
  return { everydayRaw, secretRaw };
}

async function unwrapBoth(
  record: VaultRecord,
  passphrase: string,
): Promise<{ everyday: CryptoKey; secret: CryptoKey }> {
  const { everydayRaw, secretRaw } = await unwrapRaw(record, passphrase);
  const everyday = await importContentKey(everydayRaw);
  const secret = await importContentKey(secretRaw);
  // The keys are imported and non-extractable now; the loose copies are not
  // needed and should not linger in a buffer somebody else could reach.
  everydayRaw.fill(0);
  secretRaw.fill(0);
  return { everyday, secret };
}

/**
 * Seal two account keys under a password. Always a fresh salt, and always the
 * iteration count this build ships — so changing a password is also how an
 * account picks up a stronger KDF than the one it was created with.
 */
async function sealAccountKeys(
  userId: string,
  passphrase: string,
  everydayRaw: Uint8Array,
  secretRaw: Uint8Array,
): Promise<VaultRecord> {
  const salt = randomSalt();
  const masterKey = await deriveMasterKey(passphrase, salt, KDF_ITERATIONS);
  return {
    userId,
    salt: bytesToBase64(salt),
    iterations: KDF_ITERATIONS,
    wrappedKey: bytesToBase64(await seal(masterKey, everydayRaw)),
    wrappedPrivateKey: bytesToBase64(await seal(masterKey, secretRaw)),
  };
}

/**
 * Change the master password, everywhere, from any one device.
 *
 * It is one row. The password only ever wraps the two account keys, and those
 * are untouched — so no book key is re-derived, no chapter is re-encrypted,
 * and the update log is not rewritten by a single byte. `user_keys` is the
 * only place the old password could still open anything, so overwriting it
 * retires that password globally the moment it lands.
 *
 * What this does NOT do is evict devices. A device that already unlocked holds
 * the everyday key itself, not the password, so it keeps working — which is
 * right when you are strengthening a password and wrong if you are responding
 * to a stolen laptop. Kicking every device off means rotating the account keys
 * and rewrapping each book's key under the new ones; cheap, since book keys are
 * wrapped rather than derived, but a different operation from this one.
 */
export async function changePassphrase(
  currentPassphrase: string,
  nextPassphrase: string,
): Promise<void> {
  const userId = currentUserId;
  if (!userId) throw new Error("Not signed in.");

  const lookup = await lookupVault(userId);
  if (lookup.kind !== "found") {
    throw new Error("Could not reach your key record.");
  }

  const { everydayRaw, secretRaw } = await unwrapRaw(
    lookup.record,
    currentPassphrase,
  );
  const record = await sealAccountKeys(
    userId,
    nextPassphrase,
    everydayRaw,
    secretRaw,
  );
  everydayRaw.fill(0);
  secretRaw.fill(0);

  // The server first. If it refuses, nothing has changed anywhere, and the old
  // password is still the one that works — caching the new blob before knowing
  // that would strand this device on a password no other device agrees with.
  const { error } = await supabase
    .from("user_keys")
    .update({
      salt: record.salt,
      iterations: record.iterations,
      wrapped_key: record.wrappedKey,
      wrapped_private_key: record.wrappedPrivateKey,
    })
    .eq("user_id", userId);
  if (error) throw error;

  await saveVaultRecord(record);
}

// ---------------------------------------------------------------------------
// Getting in
// ---------------------------------------------------------------------------

/**
 * Point the vault at an account, dropping anything belonging to a different one.
 *
 * The keys live in module state, which has no idea whose they are. Supabase can
 * replace one authenticated session directly with another — a magic link opened
 * while already signed in does exactly that — and without this the new account
 * would render holding the previous account's key. An early edit would then be
 * sealed under a key that account can never produce, and the words would be
 * unreadable forever. Synchronous on purpose: it has to be true before anything
 * renders against it.
 */
export function bindTo(userId: string): void {
  if (currentUserId === userId) return;
  lockPrivate();
  everydayKey = null;
  currentUserId = userId;
  announce();
}

/** Pick up the everyday key this device already holds. No password, no network. */
export async function resume(userId: string): Promise<boolean> {
  const stored = await loadDeviceKey(userId);
  // The account may have changed while this was reading. Installing the key now
  // would hand one account's key to whoever is signed in instead — and a first
  // edit sealed under it would be unreadable forever. Every path that installs a
  // key re-checks this after its last await, so the check lives with the
  // mutation rather than in whichever caller remembered to guard.
  if (currentUserId !== userId) return false;
  everydayKey = stored;
  announce();
  return stored != null;
}

/** First run for an account: mint both keys and seal them under a new password. */
export async function createVault(
  userId: string,
  passphrase: string,
): Promise<void> {
  const everydayRaw = randomKeyBytes();
  const secretRaw = randomKeyBytes();
  const record = await sealAccountKeys(
    userId,
    passphrase,
    everydayRaw,
    secretRaw,
  );

  const { error } = await supabase.from("user_keys").insert({
    user_id: userId,
    salt: record.salt,
    iterations: record.iterations,
    wrapped_key: record.wrappedKey,
    wrapped_private_key: record.wrappedPrivateKey,
  });
  if (error) throw error;

  await saveVaultRecord(record);

  const everyday = await importContentKey(everydayRaw);
  everydayRaw.fill(0);
  secretRaw.fill(0);

  if (currentUserId !== userId) return;
  everydayKey = everyday;
  await saveDeviceKey(userId, everyday);
  announce();
}

/**
 * Teach this device the everyday key. Deliberately does not install the private
 * key: see the note at the top of the file.
 */
export async function unlockDevice(
  userId: string,
  passphrase: string,
): Promise<void> {
  const lookup = await lookupVault(userId);
  if (lookup.kind === "unavailable") {
    throw new Error(
      "Layton needs a connection the first time it unlocks a device.",
    );
  }
  if (lookup.kind === "absent") {
    throw new Error("This account has no master password set yet.");
  }

  const { everyday } = await unwrapBoth(lookup.record, passphrase);
  if (currentUserId !== userId) return;
  everydayKey = everyday;
  await saveDeviceKey(userId, everyday);
  announce();
}

/** Reveal private books until the idle timer or the lock button takes them away. */
export async function unlockPrivate(passphrase: string): Promise<void> {
  const userId = currentUserId;
  if (!userId) throw new Error("Not signed in.");
  const lookup = await lookupVault(userId);
  if (lookup.kind !== "found") {
    throw new Error("Could not reach your key record.");
  }

  const { secret } = await unwrapBoth(lookup.record, passphrase);
  // Same guard as every other path that installs a key: an unlock still
  // deriving when the account changed must not hand the new one a private key
  // it can never reproduce, under which "make private" would seal a book shut
  // for good.
  if (currentUserId !== userId) return;
  privateKey = secret;
  startIdleWatch();
  announce();
}

export function lockPrivate(): void {
  if (!privateKey) return;
  privateKey = null;
  stopIdleWatch();
  announce();
}

/**
 * Sign out, forgetting this device's key *before* ending the session.
 *
 * That order is the point. Ending the session first and clearing the key
 * afterwards leaves a window in which closing the tab aborts the IndexedDB
 * delete, and the next sign-in would then resume without ever asking for the
 * master password — silently breaking the one promise sign-out makes.
 */
export async function signOut(): Promise<void> {
  await forgetThisDevice();
  await supabase.auth.signOut();
}

/** The device forgets its everyday key; the sealed rows stay put. */
export async function forgetThisDevice(): Promise<void> {
  const userId = currentUserId;
  lockPrivate();
  everydayKey = null;
  currentUserId = null;
  if (userId) await forgetDeviceKey(userId);
  announce();
}

/**
 * The only way out of a forgotten master password, and it is not a recovery —
 * it is a demolition. Every book goes, on the server and on this device, and a
 * fresh vault can then be created. There is no key that could have saved them.
 */
export async function eraseEverything(userId: string): Promise<void> {
  // Listed before anything is deleted. Afterwards there is nothing left to say
  // which cached books belonged to this account, and guessing would mean
  // clearing the store wholesale — taking another account's unsynced edits with
  // it, which exist nowhere else.
  const listed = await supabase
    .from("books")
    .select("id")
    .eq("owner_id", userId);
  if (listed.error) throw listed.error;
  const ids = (listed.data ?? []).map((row) => row.id as string);

  const books = await supabase.from("books").delete().eq("owner_id", userId);
  if (books.error) throw books.error;
  // The key record goes last. The reverse order would leave books behind that
  // nothing could ever decrypt, whereas failing here leaves an account that is
  // merely still erasable: pressing the button again finishes the job.
  const keys = await supabase.from("user_keys").delete().eq("user_id", userId);
  if (keys.error) throw keys.error;

  for (const id of ids) await deleteLocalBook(id);
  await forgetDeviceKey(userId);
  await forgetVaultRecord(userId);
  lockPrivate();
  everydayKey = null;
  announce();
}

// ---------------------------------------------------------------------------
// Book keys
// ---------------------------------------------------------------------------

export type BookKey = { key: CryptoKey; isPrivate: boolean };

function requireEveryday(): CryptoKey {
  if (!everydayKey) throw new Error("The vault is locked.");
  return everydayKey;
}

/** A fresh key for a new book, plus the sealed form to store beside it. */
export async function createBookKey(
  isPrivate = false,
): Promise<{ key: CryptoKey; wrapped: string }> {
  const wrapper = isPrivate ? privateKey : requireEveryday();
  if (!wrapper) throw new Error("Private books are locked.");

  const raw = randomKeyBytes();
  const wrapped = bytesToBase64(await seal(wrapper, raw));
  const key = await importContentKey(raw);
  raw.fill(0);
  return { key, wrapped };
}

/**
 * Open a book's key, or null when this browser is not holding the key that
 * would. Null is the ordinary answer for a private book while locked, and
 * callers are expected to treat it as "there is nothing here" rather than as
 * an error worth showing.
 */
export async function openBookKey(wrapped: string): Promise<BookKey | null> {
  const envelope = base64ToBytes(wrapped);

  if (everydayKey) {
    const raw = await tryUnseal(everydayKey, envelope);
    if (raw) {
      const key = await importContentKey(raw);
      raw.fill(0);
      return { key, isPrivate: false };
    }
  }
  if (privateKey) {
    const raw = await tryUnseal(privateKey, envelope);
    if (raw) {
      const key = await importContentKey(raw);
      raw.fill(0);
      return { key, isPrivate: true };
    }
  }
  return null;
}

/**
 * Move a book between ordinary and private.
 *
 * Only the wrapping changes. The book's own key is untouched, so every envelope
 * already written under it — the whole update log, the cached snapshot, the
 * title — stays valid and nothing has to be re-encrypted or rewritten.
 */
export async function rewrapBookKey(
  wrapped: string,
  makePrivate: boolean,
): Promise<string> {
  const from = makePrivate ? requireEveryday() : privateKey;
  const to = makePrivate ? privateKey : requireEveryday();
  if (!from || !to) throw new Error("Private books are locked.");

  const raw = await tryUnseal(from, base64ToBytes(wrapped));
  if (!raw) throw new Error("Could not open that book's key.");
  const rewrapped = bytesToBase64(await seal(to, raw));
  raw.fill(0);
  return rewrapped;
}

/**
 * Move a book between ordinary and private, everywhere that records it.
 *
 * Shared by the library and the editor because they offer the same act from
 * two places, and the three writes it takes — rewrap, row, local cache — have
 * to stay together. Two copies of this would drift the moment one of them
 * learned something the other did not.
 */
export async function moveBookPrivacy(
  bookId: string,
  wrapped: string,
  isPrivate: boolean,
): Promise<string> {
  const rewrapped = await rewrapBookKey(wrapped, isPrivate);
  const { error } = await supabase
    .from("books")
    .update({ wrapped_key: rewrapped })
    .eq("id", bookId);
  if (error) throw error;
  await updateLocalWrappedKey(bookId, rewrapped);
  return rewrapped;
}

// ---------------------------------------------------------------------------
// The idle timer
// ---------------------------------------------------------------------------

let lastActivity = 0;
let idleInterval: ReturnType<typeof setInterval> | null = null;

function noteActivity() {
  lastActivity = Date.now();
}

function checkIdle() {
  if (privateKey && Date.now() - lastActivity >= IDLE_LIMIT_MS) lockPrivate();
}

function startIdleWatch() {
  lastActivity = Date.now();
  if (idleInterval) return;
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, noteActivity, { passive: true });
  }
  // Returning to a backgrounded tab is not activity, but it is the moment the
  // answer matters most — so it triggers a check without resetting the clock.
  document.addEventListener("visibilitychange", checkIdle);
  idleInterval = setInterval(checkIdle, IDLE_CHECK_MS);
}

function stopIdleWatch() {
  if (idleInterval) clearInterval(idleInterval);
  idleInterval = null;
  for (const type of ACTIVITY_EVENTS) {
    window.removeEventListener(type, noteActivity);
  }
  document.removeEventListener("visibilitychange", checkIdle);
}
