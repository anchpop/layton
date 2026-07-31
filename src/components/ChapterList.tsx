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

import type { ChapterIndexEntry } from "@/lib/book";
import {
  addChapter,
  deleteChapter,
  moveChapter,
  renameChapter,
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

type Props = {
  doc: LoroDoc;
  chapters: ChapterIndexEntry[];
  activeId: string | null;
  /** `closePanel: false` keeps the mobile drawer open — used when creating a
   *  chapter, because the rename field lives inside that drawer. */
  onSelect: (id: string, opts?: { closePanel?: boolean }) => void;
};

export function ChapterList({ doc, chapters, activeId, onSelect }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChapterIndexEntry | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Same reason as the book title: Escape has to survive a synchronous blur.
  const renameCancelled = useRef(false);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  function startRename(chapter: ChapterIndexEntry) {
    renameCancelled.current = false;
    setEditingId(chapter.id);
    setDraft(chapter.title);
  }

  function commitRename() {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      setEditingId(null);
      return;
    }
    if (!editingId) return;
    renameChapter(doc, editingId, draft.trim());
    setEditingId(null);
  }

  function onDrop(target: number) {
    if (dragIndex != null && dragIndex !== target) {
      moveChapter(doc, dragIndex, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Chapters</SidebarGroupLabel>
      <SidebarGroupAction
        title="New chapter"
        onClick={() => {
          const created = addChapter(doc, "");
          onSelect(created.id, { closePanel: false });
          renameCancelled.current = false;
          setEditingId(created.id);
          setDraft("");
        }}
      >
        <Plus />
        <span className="sr-only">New chapter</span>
      </SidebarGroupAction>

      <SidebarMenu>
        {chapters.map((chapter, index) => {
          const isActive = chapter.id === activeId;
          const isOver = overIndex === index && dragIndex !== index;

          return (
            <SidebarMenuItem
              key={chapter.id}
              draggable={editingId !== chapter.id}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
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
              {editingId === chapter.id ? (
                <input
                  ref={inputRef}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      renameCancelled.current = true;
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder={`Chapter ${index + 1}`}
                  className="h-8 w-full rounded-md bg-transparent px-2 text-base outline-none ring-1 ring-sidebar-ring can-hover:text-sm"
                />
              ) : (
                <>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => onSelect(chapter.id)}
                    onDoubleClick={() => startRename(chapter)}
                  >
                    <span className="tabular-nums text-prose-faint">
                      {index + 1}.
                    </span>
                    <span className="truncate">
                      {chapter.title || (
                        <span className="text-prose-faint">Untitled</span>
                      )}
                    </span>
                  </SidebarMenuButton>

                  {/* Every chapter action lives here, not only behind a
                      double-click. On a phone the first tap opens the chapter
                      and closes the drawer, so a second click never arrives —
                      and dragging to reorder is unavailable on touch and to
                      keyboard users besides. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction
                        showOnHover
                        title={`Actions for ${chapter.title || "this chapter"}`}
                      >
                        <MoreHorizontal />
                        <span className="sr-only">Chapter actions</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem onSelect={() => startRename(chapter)}>
                        <Pencil className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === 0}
                        onSelect={() => moveChapter(doc, index, index - 1)}
                      >
                        <ArrowUp className="size-4" />
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === chapters.length - 1}
                        onSelect={() => moveChapter(doc, index, index + 1)}
                      >
                        <ArrowDown className="size-4" />
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setPendingDelete(chapter)}
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

        {chapters.length === 0 && (
          <li className="px-2 py-3 text-sm text-muted-foreground">
            No chapters yet.
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
              This removes the chapter and everything written in it, on every
              device. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) deleteChapter(doc, pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete chapter
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  );
}
