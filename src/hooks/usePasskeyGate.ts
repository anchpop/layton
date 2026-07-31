import { useCallback, useEffect, useState } from "react";

import {
  isPasskeySupported,
  listPasskeys,
  promptDismissed,
} from "../lib/passkey";

type GateState = "checking" | "prompt" | "clear";

/**
 * Decides whether to show the one-time passkey enrollment screen.
 *
 * Prompts only when the *account* has no passkeys at all. A second device
 * usually inherits one through iCloud Keychain or Google Password Manager, and
 * anyone who wants a device-bound key can add one from the library — so
 * re-prompting per device would be noise.
 *
 * Any failure resolves to "clear". Being unable to check (offline, most
 * likely) must never stand between someone and their writing.
 */
export function usePasskeyGate(userId: string | null) {
  const [state, setState] = useState<GateState>("checking");

  const check = useCallback(() => {
    if (!userId || !isPasskeySupported() || promptDismissed()) {
      setState("clear");
      return undefined;
    }

    let cancelled = false;
    setState("checking");

    listPasskeys()
      .then((keys) => {
        if (!cancelled) setState(keys.length === 0 ? "prompt" : "clear");
      })
      .catch(() => {
        if (!cancelled) setState("clear");
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => check(), [check]);

  return { state, resolve: () => setState("clear") };
}
