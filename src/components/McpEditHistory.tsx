import { useEffect, useState } from "react";
import { History } from "lucide-react";
import type { LoroDoc } from "loro-crdt";
import { mcpHistory, type McpHistoryEntry } from "@/lib/mcpHistory";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function McpEditHistory({ doc }: { doc: LoroDoc }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<McpHistoryEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setEntries(mcpHistory(doc).slice(0, 100));
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = doc.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [doc, open]);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button variant="ghost" size="sm" className="-ml-2 h-6 w-fit gap-1.5 px-2 text-[0.7rem] font-normal text-muted-foreground">
        <History className="size-3" />AI edit history
      </Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>AI edit history</DialogTitle>
        <DialogDescription>Recent edits from your connected AI apps.</DialogDescription>
      </DialogHeader>
      {entries.length === 0 ? <p className="text-sm text-muted-foreground">No edits from connected apps yet.</p> :
        <ol className="max-h-[60vh] space-y-4 overflow-y-auto">
          {entries.map(entry => <li key={entry.id} className="space-y-1 border-b pb-3 text-sm last:border-0">
            <p><span className="font-medium">{entry.app}</span> <span className="text-muted-foreground">via MCP</span></p>
            <p>{entry.action}</p>
            <time className="text-xs text-muted-foreground" dateTime={new Date(entry.timestamp * 1000).toISOString()}>{new Date(entry.timestamp * 1000).toLocaleString()}</time>
          </li>)}
        </ol>}
      {entries.length === 100 && <p className="text-xs text-muted-foreground">Showing the latest 100 AI edits.</p>}
    </DialogContent>
  </Dialog>;
}
