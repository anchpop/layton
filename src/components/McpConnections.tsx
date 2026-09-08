import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";

type Connection = { id: string; client_name: string; redirect_uri: string; include_private: boolean; expires_at: string; can_edit: boolean };
export function McpConnections() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void supabase.from("mcp_connections").select("id,client_name,redirect_uri,include_private,expires_at,can_edit")
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setError("Could not load AI connections.");
        else setConnections(data);
      });
    return () => { active = false; };
  }, []);
  async function revoke(id: string) {
    setBusy(id); setError(null);
    const { error } = await supabase.from("mcp_connections").delete().eq("id", id);
    if (error) setError("Could not revoke this connection. Try again.");
    else setConnections(previous => previous?.filter(c => c.id !== id) ?? []);
    setBusy(null);
  }
  return <section className="space-y-3">
    <h3 className="text-sm font-medium">AI connections</h3>
    <p className="text-xs text-muted-foreground">Connect an AI app using <code>{window.location.origin}/mcp</code> and OAuth.</p>
    {connections === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
    {connections?.length === 0 && <p className="text-sm text-muted-foreground">No connected apps.</p>}
    <div className="max-h-48 space-y-3 overflow-y-auto">
      {connections?.map(connection => <div key={connection.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
        <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
          <p className="text-sm font-medium text-foreground">{connection.client_name}</p>
          <p>{connection.include_private ? "Includes private stories" : "Ordinary stories only"} · {connection.can_edit ? "Read and edit" : "Read only"}</p>
          <p className="break-all">{connection.redirect_uri}</p>
          <p>Expires {new Date(connection.expires_at).toLocaleDateString()}</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void revoke(connection.id)}>{busy === connection.id ? "Revoking…" : "Revoke"}</Button>
      </div>)}
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
