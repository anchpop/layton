import type { LoroDoc } from "loro-crdt";

const actions: Record<string, string> = {
  replace_text: "Edited text",
  append_to_chapter: "Appended text",
  create_chapter: "Added a chapter",
  rename_story: "Renamed the story",
  rename_chapter: "Renamed a chapter",
};

export type McpHistoryEntry = {
  id: string; app: string; action: string; timestamp: number; lamport: number; chapterId?: string;
};

/** Persisted commit messages travel inside the encrypted CRDT log, including
 * its compacted snapshots. No side table of plaintext edit descriptions. */
export function mcpHistory(doc: LoroDoc): McpHistoryEntry[] {
  const entries: McpHistoryEntry[] = [];
  for (const changes of doc.getAllChanges().values()) {
    for (const change of changes) {
      if (!change.message) continue;
      try {
        const message = JSON.parse(change.message);
        if (message?.v !== 1 || message.source !== "mcp" || typeof message.clientName !== "string" || typeof message.action !== "string" || !Object.hasOwn(actions, message.action)) continue;
        entries.push({ id: `${change.peer}:${change.counter}`, app: message.clientName.slice(0, 200),
          action: actions[message.action], timestamp: change.timestamp, lamport: change.lamport,
          ...(typeof message.chapterId === "string" ? { chapterId: message.chapterId } : {}) });
      } catch { /* Other clients may use free-form commit messages. */ }
    }
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp || b.lamport - a.lamport || a.id.localeCompare(b.id));
}
