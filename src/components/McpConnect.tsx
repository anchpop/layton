import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { delegateMcpKeys } from "@/lib/mcpKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function McpConnect({ userId, email }: { userId: string; email: string }) {
  const query = window.location.search.slice(1);
  const [client, setClient] = useState<{ clientName: string; redirectUri: string; canEdit: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [includePrivate, setIncludePrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/mcp/request?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("This connection request is invalid or expired. Start again from your AI app.");
        setClient(await response.json());
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [query]);

  async function submit(deny = false) {
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || session.user.id !== userId) throw new Error("Sign in again before connecting.");
      let keys;
      if (!deny) {
        // Always use the current server record; do not export the device key or
        // use the private-unlocked state as consent for a different recipient.
        const { data, error } = await supabase.from("user_keys")
          .select("salt,iterations,wrapped_key,wrapped_private_key").eq("user_id", userId).single();
        if (error || !data) throw new Error("Could not load your vault. Set up your master password in Layton first.");
        try { keys = await delegateMcpKeys(data, password, includePrivate); }
        catch { throw new Error("That master password does not match."); }
      }
      setPassword("");
      const response = await fetch("/api/mcp/authorize", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ query, includePrivate, keys, deny }),
      });
      keys = undefined;
      if (!response.ok) throw new Error("Could not connect. Please try again.");
      const result = await response.json();
      // The server validates the registered redirect and adds only OAuth data.
      window.location.assign(result.redirectTo);
    } catch (error) {
      setPassword("");
      setError(error instanceof Error ? error.message : "Could not connect.");
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) { event.preventDefault(); void submit(); }
  return (
    <main className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-md space-y-6">
        <div>
          <p className="text-sm text-muted-foreground">Layton · {email}</p>
          <h1 className="mt-2 font-prose text-3xl">Connect your stories</h1>
        </div>
        {client ? <>
          <div className="space-y-2 text-sm">
            <p><strong>{client.clientName}</strong> wants to {client.canEdit ? "read and edit" : "read and search"} your stories.</p>
            <p className="break-all text-muted-foreground">Return address: {client.redirectUri}</p>
            <p className="text-muted-foreground">The app supplies its name. Check that you recognize it and the return address.</p>
          </div>
          <form onSubmit={onSubmit} className="space-y-5">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 text-sm">
              <input type="checkbox" className="mt-1" checked={includePrivate} onChange={event => setIncludePrivate(event.target.checked)} disabled={busy} />
              <span><span className="font-medium">Include private stories</span>
                <span className="mt-1 block text-muted-foreground">Allow this connection to {client.canEdit ? "read and edit" : "read"} private stories even while your library is locked.</span>
              </span>
            </label>
            <p className="text-sm text-muted-foreground">You're giving {client.clientName} access to your writing. Revoke it in Account → AI connections at any time.</p>
            <div className="space-y-2">
              <Label htmlFor="mcp-password">Master password</Label>
              <Input id="mcp-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} />
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={busy || !password}>{busy ? "Connecting…" : client.canEdit ? "Allow read and edit access" : "Allow read access"}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void submit(true)}>Cancel</Button>
            </div>
          </form>
        </> : !error && <p className="text-sm text-muted-foreground">Loading connection request…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <a className="text-sm underline text-muted-foreground" href="/">Back to Layton</a>
      </div>
    </main>
  );
}
