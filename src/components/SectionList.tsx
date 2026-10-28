import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { LoroDoc } from "loro-crdt";

import type { IndexEntry, Section } from "@/lib/book";
import {
  deleteEntry,
  moveEntry,
  renameEntry,
  titlePlaceholder,
} from "@/lib/book";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useTitleEdit } from "@/hooks/useTitleEdit";

type Props = {
  doc: LoroDoc;
  entries: IndexEntry[];
  section: Section;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

export function SectionList({ doc, section, entries, activeId, onSelect, onCreate }: Props) {
  const noun = section === "chapters" ? "chapter" : "note";
  const label = section === "chapters" ? "Chapters" : "Notes";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<IndexEntry | null>(
    null,
  );
  function startRename(entry: IndexEntry) {
    setEditingId(entry.id);
  }

  function onDrop(target: number) {
    if (dragIndex != null && dragIndex !== target) {
      moveEntry(doc, section, dragIndex, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupAction
        title={`New ${noun}`}
        onClick={onCreate}
      >
        <Plus />
        <span className="sr-only">New {noun}</span>
      </SidebarGroupAction>

      <SidebarMenu>
        {entries.map((entry, index) => {
          const isActive = entry.id === activeId;
          const isOver = dragIndex != null && overIndex === index && dragIndex !== index;

          return (
            <SidebarMenuItem
              key={entry.id}
              draggable={editingId !== entry.id}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
                if (dragIndex == null) return;
                e.preventDefault();
                setOverIndex(index);
              }}
              onDragLeave={() => setOverIndex((i) => (i === index ? null : i))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(index);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={cn(
                "rounded-md",
                isOver && "shadow-[inset_0_2px_0_0_var(--sidebar-ring)]",
                dragIndex === index && "opacity-40",
              )}
            >
              {editingId === entry.id ? (
                <EntryRename
                  key={entry.id}
                  doc={doc}
                  entry={entry}
                  placeholder={titlePlaceholder(section, index + 1)}
                  noun={noun}
                  onFinish={() => setEditingId(null)}
                />
              ) : (
                <>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => onSelect(entry.id)}
                    onDoubleClick={() => startRename(entry)}
                  >
                    {section === "chapters" && <span className="tabular-nums text-prose-faint">
                      {index + 1}.
                    </span>}
                    <span className="truncate">
                      {entry.title || (
                        <span className="text-prose-faint">Untitled</span>
                      )}
                    </span>
                  </SidebarMenuButton>

                  {/* Every entry action lives here, not only behind a
                      double-click. On a phone the first tap opens the document
                      and closes the drawer, so a second click never arrives —
                      and dragging to reorder is unavailable on touch and to
                      keyboard users besides. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction
                        showOnHover
                        title={`Actions for ${entry.title || `this ${noun}`}`}
                      >
                        <MoreHorizontal />
                        <span className="sr-only">Actions for this {noun}</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem onSelect={() => startRename(entry)}>
                        <Pencil className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === 0}
                        onSelect={() => moveEntry(doc, section, index, index - 1)}
                      >
                        <ArrowUp className="size-4" />
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === entries.length - 1}
                        onSelect={() => moveEntry(doc, section, index, index + 1)}
                      >
                        <ArrowDown className="size-4" />
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setPendingDelete(entry)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </SidebarMenuItem>
          );
        })}

        {entries.length === 0 && (
          <li className="px-2 py-3 text-sm text-muted-foreground">
            No {section} yet.
          </li>
        )}
      </SidebarMenu>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{pendingDelete?.title || "Untitled"}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {noun} and everything written in it, on every
              device. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) deleteEntry(doc, pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete {noun}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  );
}

function EntryRename({ doc, entry, placeholder, noun, onFinish }: {
  doc: LoroDoc;
  entry: IndexEntry;
  placeholder: string;
  noun: string;
  onFinish: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const edit = useTitleEdit(entry.title, (title) => renameEntry(doc, entry.id, title), { onFinish });
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      {...edit}
      autoFocus
      aria-label={`Rename ${noun}`}
      placeholder={placeholder}
      className="h-8 w-full rounded-md bg-transparent px-2 text-base outline-none ring-1 ring-sidebar-ring can-hover:text-sm"
    />
  );
}
