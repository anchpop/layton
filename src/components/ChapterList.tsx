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
import { useTitleEdit } from "@/hooks/useTitleEdit";

type Props = {
  doc: LoroDoc;
  chapters: ChapterIndexEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

export function ChapterList({ doc, chapters, activeId, onSelect, onCreate }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ChapterIndexEntry | null>(
    null,
  );
  function startRename(chapter: ChapterIndexEntry) {
    setEditingId(chapter.id);
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
        onClick={onCreate}
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
                <ChapterRename
                  key={chapter.id}
                  doc={doc}
                  chapter={chapter}
                  number={index + 1}
                  onFinish={() => setEditingId(null)}
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

function ChapterRename({ doc, chapter, number, onFinish }: {
  doc: LoroDoc;
  chapter: ChapterIndexEntry;
  number: number;
  onFinish: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const edit = useTitleEdit(chapter.title, (title) => renameChapter(doc, chapter.id, title), { onFinish });
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      {...edit}
      autoFocus
      aria-label="Rename chapter"
      placeholder={`Chapter ${number}`}
      className="h-8 w-full rounded-md bg-transparent px-2 text-base outline-none ring-1 ring-sidebar-ring can-hover:text-sm"
    />
  );
}
