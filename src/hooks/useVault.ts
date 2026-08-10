import { useEffect, useState } from "react";

import {
  bindTo,
  lookupVault,
  resume,
  subscribe,
  status as vaultStatus,
  type VaultStatus,
} from "../lib/vault";

/**
 * What has to happen before the library can be shown.
 *
 *   checking  working it out
 *   setup     this account has never had a master password
 *   locked    it has one, and this device does not hold the everyday key
 *   open      ordinary books are readable
 *
 * "Could not reach the server" resolves to `locked`, never to `setup`. Offering
 * to create a vault when the answer is merely unknown would let a bad
 * connection walk someone into a second master password over the top of a
 * perfectly good one, and the books sealed under the first would be gone.
 */
export type VaultGate = "checking" | "setup" | "locked" | "open";

export function useVault(userId: string | null): {
  gate: VaultGate;
  /**
   * Ask again from scratch. Needed after erasing an account: the answer changes
   * from "locked" to "setup" without any key being handed over, so the vault has
   * nothing to announce and the gate would otherwise sit on a password screen
   * for books that no longer exist.
   */
  recheck: () => void;
} {
  const [gate, setGate] = useState<VaultGate>("checking");
  const [probe, setProbe] = useState(0);

  useEffect(() => {
    if (!userId) {
      setGate("checking");
      return;
    }

    // Both synchronous, before any child renders: whose keys these are is not
    // something the vault can work out for itself, and a gate left open across
    // an account change would show one person's library to another.
    bindTo(userId);
    setGate("checking");

    let cancelled = false;
    void (async () => {
      // The device key needs neither password nor network: an installed app on
      // a plane must reach the writing, not a prompt.
      if (await resume(userId)) return;
      const lookup = await lookupVault(userId);
      if (!cancelled) setGate(lookup.kind === "absent" ? "setup" : "locked");
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, probe]);

  // The vault itself is the authority on whether the key is in hand, so the
  // gate follows it rather than each screen remembering to report back.
  useEffect(
    () =>
      subscribe((status) => {
        if (status.unlocked) setGate("open");
        else setGate((current) => (current === "open" ? "locked" : current));
      }),
    [],
  );

  return {
    gate,
    recheck: () => {
      setGate("checking");
      setProbe((n) => n + 1);
    },
  };
}

/** Live view of which keys are held. Drives the lock button and what it hides. */
export function useVaultStatus(): VaultStatus {
  const [status, setStatus] = useState<VaultStatus>(vaultStatus);
  useEffect(() => subscribe(setStatus), []);
  return status;
}
