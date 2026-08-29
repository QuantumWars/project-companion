"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { ChevronDown, Menu, Share2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Hint } from "@/components/hint";
import { Actions } from "@/components/actions";
import { StoreBadge } from "@/components/store-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ensureBoard, useBoard } from "@/lib/local-boards";
import { useRenameModal } from "@/store/use-rename-modal";
import {
  DIAGRAM_TYPE_IDS,
  DIAGRAM_TYPE_LABELS,
  type DiagramType,
} from "@/types/arch";

export const DIAGRAM_TYPES: { id: DiagramType; label: string }[] = DIAGRAM_TYPE_IDS.map(
  (id) => ({ id, label: DIAGRAM_TYPE_LABELS[id] }),
);

interface TopbarProps {
  boardId: string;
  source: "local" | "file";
  diagramType: DiagramType;
  onDiagramTypeChange: (type: DiagramType) => void;
}

export const Topbar = ({
  boardId,
  source,
  diagramType,
  onDiagramTypeChange,
}: TopbarProps) => {
  const { onOpen } = useRenameModal();
  const board = useBoard(boardId);

  // The diagram type comes from localStorage, which the server cannot know, so
  // rendering its label during hydration produces a text mismatch. Hold the
  // label back until mounted rather than guessing on the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // A board reached by direct URL may not be in the registry yet. Registering
  // it from this route is what stamps it as an architecture board.
  const [fileTitle, setFileTitle] = useState<string | null>(null);

  useEffect(() => {
    if (source === "file") {
      // A file-backed diagram is not in the localStorage board registry; its
      // title lives in .arch/project.json.
      fetch(`/api/project/diagrams/${encodeURIComponent(boardId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setFileTitle(d.title))
        .catch(() => {});
      return;
    }

    ensureBoard(boardId, "arch");
  }, [boardId, source]);

  const current =
    DIAGRAM_TYPES.find((t) => t.id === diagramType) ?? DIAGRAM_TYPES[0];

  const title = source === "file" ? fileTitle ?? boardId : board?.title ?? "Untitled";

  return (
    <header className="absolute inset-x-0 top-0 z-30 flex h-14 items-center gap-x-3 border-b border-line bg-panel px-3">
      <Hint label="Go to boards" side="bottom" sideOffset={8}>
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href="/">
            <Menu className="h-4 w-4" />
          </Link>
        </Button>
      </Hint>

      <Link href="/" className="flex shrink-0 items-center gap-x-2">
        <Image src="/logo.svg" alt="Logo" height={22} width={22} />
      </Link>

      <span className="h-5 w-px shrink-0 bg-neutral-200" />

      {source === "file" ? (
        <div className="flex min-w-0 items-center gap-x-2">
          <span className="truncate text-sm font-medium text-fg">
            {title}
          </span>
          {/* Say which store is being edited -- the difference matters. */}
          <StoreBadge />
        </div>
      ) : (
        <>
          <Actions id={boardId} title={title} side="bottom" sideOffset={8}>
            <button className="flex min-w-0 items-center gap-x-1.5 rounded px-2 py-1 text-sm font-medium text-fg hover:bg-bg-subtle">
              <span className="truncate">{title}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            </button>
          </Actions>
          <button
            onClick={() => board && onOpen(board.id, board.title)}
            className="shrink-0 rounded px-1.5 py-1 text-xs text-fg-subtle hover:bg-bg-subtle hover:text-fg"
          >
            Rename
          </button>
        </>
      )}

      {/* The diagram type sits centre-stage, the way Miro surfaces the active
          diagramming mode. It biases the shape library rather than locking the
          canvas to one family. */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="pointer-events-auto flex min-w-[112px] items-center justify-center gap-x-2 rounded-full bg-brand px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-neutral-800">
              {mounted ? current.label : "\u00a0"}
              <ChevronDown className="h-3 w-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-48">
            {DIAGRAM_TYPES.map((type) => (
              <DropdownMenuItem
                key={type.id}
                className={cn(
                  "cursor-pointer text-sm",
                  type.id === diagramType && "font-medium text-brand",
                )}
                onClick={() => onDiagramTypeChange(type.id)}
              >
                {type.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-x-2">
        {source === "file" ? (
          <Button asChild size="sm" variant="ghost" className="h-8">
            <Link href="/project/tasks">Tasks</Link>
          </Button>
        ) : null}
        <Button size="sm" className="h-8 gap-x-1.5">
          <Share2 className="h-3.5 w-3.5" />
          Share
        </Button>
      </div>
    </header>
  );
};
