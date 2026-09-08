import { base64ToBytes, bytesToBase64 } from "./bytes";
import { deriveMasterKey, unseal } from "./crypto";

export type DelegatedKeys = { everydayKey: string; privateKey?: string };

/** Password derivation stays in the browser. A non-private consent does not
 * even unwrap the private key, irrespective of the library's lock state. */
export async function delegateMcpKeys(
  record: { salt: string; iterations: number; wrapped_key: string; wrapped_private_key: string },
  password: string,
  includePrivate: boolean,
): Promise<DelegatedKeys> {
  const master = await deriveMasterKey(password, base64ToBytes(record.salt), record.iterations);
  const everyday = await unseal(master, base64ToBytes(record.wrapped_key));
  let privateRaw: Uint8Array | undefined;
  try {
    if (includePrivate) privateRaw = await unseal(master, base64ToBytes(record.wrapped_private_key));
    return {
      everydayKey: bytesToBase64(everyday),
      ...(privateRaw ? { privateKey: bytesToBase64(privateRaw) } : {}),
    };
  } finally {
    everyday.fill(0);
    privateRaw?.fill(0);
  }
}
