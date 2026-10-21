import { base64ToBytes, bytesToBase64 } from "./bytes";
import { importContentKey, seal, unseal } from "./crypto";

/**
 * The public half of the model server's long-term signing key (ECDSA P-256,
 * SPKI). Its private half is the `layton-ai-signing-key` Modal secret. Built
 * into the app on purpose: a pin fetched through the relay could be swapped by
 * the relay. Rotating it means model/generate_signing_key.py, the secret, and
 * this constant together.
 */
export const AI_SIGNING_SPKI =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElf6wpcyzzKK/rKJLxkw3/jlFQmPMsgQWTh2Elaj7mH0hKW5AdxWELPvmYV8+l0/5q68SSPBhyjwdJamFje1DeQ==";
export const VERSION = 2;
const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true });
const encode = (value: unknown) => utf8.encode(JSON.stringify(value));
export type KeyStatement = { version: number; keyId: string; publicKey: string; expiresAt: number; signature: string };
let cached: KeyStatement | undefined;

export async function verifyStatement(statement: KeyStatement, pin = AI_SIGNING_SPKI, now = Date.now() / 1000): Promise<void> {
  if (statement.version !== VERSION || !/^[0-9a-f]{32}$/.test(statement.keyId) ||
      !Number.isSafeInteger(statement.expiresAt) || statement.expiresAt <= now ||
      base64ToBytes(statement.publicKey).length !== 65) throw new Error("Invalid AI key statement");
  const key = await crypto.subtle.importKey("spki", base64ToBytes(pin) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  // JSON arrays with fixed field order are the canonical wire encoding (no whitespace).
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
    base64ToBytes(statement.signature) as BufferSource,
    encode([VERSION, statement.keyId, statement.publicKey, statement.expiresAt]) as BufferSource);
  if (!valid) throw new Error("AI server signature did not verify");
}

export async function serverStatement(token: string, refresh = false): Promise<KeyStatement> {
  if (!refresh && cached && cached.expiresAt > Date.now() / 1000 + 15) return cached;
  const response = await fetch("/api/ai-key", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) throw new Error("The AI server key could not be reached.");
  const statement = await response.json() as KeyStatement;
  await verifyStatement(statement);
  cached = statement;
  return statement;
}

export type ContinuationSession = {
  gen: string; keyId: string; epk: string; reqKey: CryptoKey; streamKey: CryptoKey;
  resKey: CryptoKey; resKeyRaw: Uint8Array;
};

export async function handshake(statement: KeyStatement, previous?: ContinuationSession): Promise<ContinuationSession> {
  const params = { name: "ECDH", namedCurve: "P-256" };
  const server = await crypto.subtle.importKey("raw", base64ToBytes(statement.publicKey) as BufferSource, params, false, []);
  const pair = await crypto.subtle.generateKey(params, false, ["deriveBits"]);
  const epk = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const gen = previous?.gen ?? crypto.randomUUID();
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: server }, pair.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const transcript = [VERSION, statement.keyId, statement.publicKey, epk, gen];
  const derive = async (purpose: string) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
    salt: new Uint8Array(), info: encode(["layton-ai", ...transcript, purpose]) as BufferSource }, material, 256));
  // A pending marker already wraps this key. Carry it inside the new sealed
  // request on a key-rotation retry, never silently strand the recoverable result.
  const resKeyRaw = previous?.resKeyRaw ?? await derive("result");
  return { gen, keyId: statement.keyId, epk, reqKey: await importContentKey(await derive("request")),
    streamKey: await importContentKey(await derive("stream")), resKey: await importContentKey(resKeyRaw), resKeyRaw };
}

const aad = (gen: string, type: string, seq: number) => encode([VERSION, gen, type, seq]);
export async function sealRequest(session: ContinuationSession, prompt: string, maxTokens: number): Promise<string> {
  const payload = encode({ prompt, maxTokens, gen: session.gen,
    resultKey: bytesToBase64(session.resKeyRaw) });
  // Spaces are valid trailing JSON whitespace; pad UTF-8 bytes, not JS characters.
  const padded = new Uint8Array(2 ** Math.ceil(Math.log2(Math.max(4096, payload.length)))).fill(32);
  padded.set(payload);
  return bytesToBase64(await seal(session.reqKey, padded, aad(session.gen, "request", 0)));
}
export async function textHash(value: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(value))));
}
export async function openResult(key: CryptoKey, gen: string, sealed: string): Promise<{ text: string }> {
  const result = JSON.parse(text.decode(await unseal(key, base64ToBytes(sealed), aad(gen, "result", 0))));
  if (typeof result.text !== "string" || result.hash !== await textHash(result.text) || result.done !== true)
    throw new Error("Invalid stored AI result");
  return result;
}

/** The model itself reported failure, in an authenticated frame. */
export class ModelFailed extends Error {}

/**
 * Anything else that goes wrong reading the stream — a frame out of order,
 * one that fails authentication, a final record that does not add up — is
 * thrown as a plain Error, and the caller treats it exactly like a dropped
 * connection: the server's verified copy is still there to be recovered.
 */
export class StreamVerifier {
  private seq = 0;
  private parts: string[] = [];
  private final = false;
  private key: CryptoKey;
  private gen: string;
  constructor(key: CryptoKey, gen: string) { this.key = key; this.gen = gen; }
  async accept(line: string): Promise<string | undefined> {
    const frame = JSON.parse(line);
    if (this.final || frame.seq !== this.seq || !["delta", "final", "error"].includes(frame.type))
      throw new Error("Invalid AI stream order");
    const opened = JSON.parse(text.decode(await unseal(this.key, base64ToBytes(frame.data), aad(this.gen, frame.type, this.seq))));
    if (frame.type === "error") throw new ModelFailed("The model could not complete this request.");
    if (frame.type === "delta") {
      if (typeof opened.t !== "string") throw new Error("Invalid AI delta");
      this.parts.push(opened.t);
      this.seq++;
      return opened.t;
    }
    if (opened.count !== this.seq || opened.hash !== await textHash(this.parts.join("")) || opened.done !== true)
      throw new Error("Invalid AI final record");
    this.final = true;
  }
  finish(): void {
    if (!this.final) throw new Error("The AI stream ended early.");
  }
}
