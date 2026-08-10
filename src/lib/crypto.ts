import { base64ToBytes, bytesToBase64 } from "./bytes";

/**
 * The primitives everything else is built from. All WebCrypto: no dependency,
 * no hand-rolled cipher, no key material this file cannot account for.
 *
 * There is exactly one ciphertext format in Layton — the sealed envelope below
 * — and it is used for prose, snapshots, titles, and the account keys
 * themselves. One format means one place to get the nonce handling right, and
 * one place to change if it ever needs changing.
 *
 *   ┌─────────┬────────────┬──────────────────────────┐
 *   │ version │ IV (12 B)  │ AES-GCM ciphertext + tag │
 *   └─────────┴────────────┴──────────────────────────┘
 *
 * The IV is random per envelope. AES-GCM's birthday bound makes that safe to
 * around 2^32 messages under one key; a book key seals one envelope per edit,
 * so the real ceiling is billions of keystrokes per book.
 *
 * The version byte is what makes a future format change possible without
 * guesswork: an old envelope stays readable because it says what it is.
 */

/**
 * OWASP's floor for PBKDF2-HMAC-SHA256, and roughly a second on a phone.
 * Stored alongside each account so it can be raised later without stranding
 * anyone — see `iterations` in the user_keys table.
 */
export const KDF_ITERATIONS = 600_000;

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * TypeScript 5.7 made Uint8Array generic over its backing buffer, and WebCrypto
 * accepts only the non-shared kind. Nothing in Layton allocates on a
 * SharedArrayBuffer — there is no worker and no cross-origin isolation — so
 * this is a typing formality at the boundary rather than a claim that wants a
 * runtime check. Kept in one place so the assertion is not sprinkled through
 * the call sites.
 */
function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export function randomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      bufferSource(plaintext),
    ),
  );
  const envelope = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(iv, 1);
  envelope.set(ciphertext, 1 + IV_BYTES);
  return envelope;
}

/** Throws if the key is wrong, the bytes are damaged, or the format is unknown. */
export async function unseal(
  key: CryptoKey,
  envelope: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.length <= 1 + IV_BYTES) {
    throw new Error("Truncated envelope");
  }
  if (envelope[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unknown envelope version ${envelope[0]}`);
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(envelope.subarray(1, 1 + IV_BYTES)) },
    key,
    bufferSource(envelope.subarray(1 + IV_BYTES)),
  );
  return new Uint8Array(plaintext);
}

/**
 * Unseal, or null if this key is not the one.
 *
 * The distinction matters: trying a key and having it fail is a *normal* event
 * here, not an error. It is how a private book is told apart from an ordinary
 * one without the server recording which is which.
 */
export async function tryUnseal(
  key: CryptoKey,
  envelope: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    return await unseal(key, envelope);
  } catch {
    return null;
  }
}

export async function sealText(key: CryptoKey, text: string): Promise<string> {
  return bytesToBase64(await seal(key, utf8.encode(text)));
}

export async function unsealText(
  key: CryptoKey,
  sealed: string,
): Promise<string> {
  return fromUtf8.decode(await unseal(key, base64ToBytes(sealed)));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The master password, stretched into the key that the two account keys are
 * sealed under. This is the only thing standing between a stolen database dump
 * and someone's novel, which is what the iteration count is buying.
 *
 * NFKC-normalised so the same password typed on a phone keyboard and a Mac
 * derives the same key — an unnormalised passphrase with an accented character
 * or a full-width space in it can unlock on one device and fail on another.
 */
export async function deriveMasterKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    bufferSource(utf8.encode(passphrase.normalize("NFKC"))),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bufferSource(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Raw bytes to a usable key, deliberately non-extractable.
 *
 * Non-extractable is what lets the everyday key live in IndexedDB across
 * restarts without the raw bytes ever being readable by script again. Getting
 * them back requires the password and the sealed copy on the server, which is
 * exactly the property a password change should have.
 */
export function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bufferSource(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
