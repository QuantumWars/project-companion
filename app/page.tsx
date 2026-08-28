"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { FolderGit2, Network, Pencil, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { Actions } from "@/components/actions";
import { StoreBadge } from "@/components/store-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  boardHref,
  boardKind,
  createBoard,
  useBoards,
  type BoardKind,
} from "@/lib/local-boards";

type ProjectInfo = {
  configured: boolean;
  name?: string;
  root?: string;
  diagrams?: { id: string; title: string; type: string; kind?: string }[];
};

type IndexedProject = {
  path: string;
  name: string;
  diagrams: number;
  tasks: number;
};

const DashboardPage = () => {
  const boards = useBoards();
  const router = useRouter();

  // Diagrams that live in the repo's .arch/ directory -- the ones a coding
  // agent can also read and write.
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [indexed, setIndexed] = useState<{ current: string | null; projects: IndexedProject[] }>({
    current: null,
    projects: [],
  });

  useEffect(() => {
    fetch("/api/project")
      .then((r) => r.json())
      .then(setProject)
      .catch(() => setProject({ configured: false }));

    // Every project this machine knows about, from the global index.
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setIndexed)
      .catch(() => {});
  }, []);

  const onCreate = (kind: BoardKind) => {
    const board = createBoard(
      kind === "arch" ? "Untitled diagram" : "Untitled",
      kind,
    );
    router.push(boardHref(board));
  };

  return (
    <main className="mx-auto h-full max-w-6xl p-6">
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-x-2">
          <Image src="/logo.svg" alt="Logo" height={40} width={40} />
          <h1 className="text-2xl font-semibold">Boards</h1>
        </div>
        <NewBoardButton onCreate={onCreate} />
      </div>

      {project?.configured && project.diagrams?.length ? (
        <section className="mb-10">
          <div className="mb-3 flex items-center gap-x-2">
            <FolderGit2 className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-semibold text-neutral-800">
              {project.name}
            </h2>
            <StoreBadge />
            <span className="truncate text-xs text-neutral-400">
              {project.root}
            </span>
            <Link
              href="/project/tasks"
              className="ml-auto rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
            >
              Task board
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {project.diagrams.map((d) => (
              <Link
                key={d.id}
                href={
                  d.kind === "whiteboard"
                    ? `/project/board/${d.id}`
                    : `/project/${d.id}`
                }
                className="group rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-emerald-400"
              >
                {d.kind === "whiteboard" ? (
                  <Pencil className="mb-3 h-6 w-6 text-amber-500" />
                ) : (
                  <Network className="mb-3 h-6 w-6 text-emerald-500" />
                )}
                <p className="truncate text-sm font-medium text-neutral-800">
                  {d.title}
                </p>
                <p className="truncate text-xs text-neutral-400">
                  {d.kind === "whiteboard" ? "whiteboard" : d.type}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {indexed.projects.length > 1 ? (
        <section className="mb-10">
          <div className="mb-3 flex items-center gap-x-2">
            <FolderGit2 className="h-4 w-4 text-neutral-500" />
            <h2 className="text-sm font-semibold text-neutral-800">
              All projects on this machine
            </h2>
            <span className="text-xs text-neutral-400">
              {indexed.projects.length}
            </span>
          </div>
          <div className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
            {indexed.projects.map((p) => (
              <div
                key={p.path}
                className="flex items-center gap-x-3 px-4 py-2.5 text-sm"
              >
                <span className="font-medium text-neutral-800">{p.name}</span>
                {p.path === indexed.current ? (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700">
                    open here
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-neutral-400">
                  {p.diagrams} diagrams &middot; {p.tasks} tasks
                </span>
                <span className="w-[38%] truncate text-xs text-neutral-400">
                  {p.path}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {boards.length === 0 ? (
        <div className="flex h-[60vh] flex-col items-center justify-center">
          <Image src="/note.svg" alt="Empty" height={140} width={140} />
          <h2 className="mt-6 text-2xl font-semibold">Create your first board</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Boards are stored in this browser.
          </p>
          <div className="mt-6 flex gap-x-3">
            <Button size="lg" onClick={() => onCreate("whiteboard")}>
              <Pencil className="mr-2 h-4 w-4" />
              Whiteboard
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => onCreate("arch")}
            >
              <Network className="mr-2 h-4 w-4" />
              Architecture
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {boards.map((board) => {
            const kind = boardKind(board);
            const isArch = kind === "arch";

            return (
              <div
                key={board.id}
                className="group flex aspect-[100/127] flex-col justify-between overflow-hidden rounded-lg border bg-white"
              >
                <Link
                  href={boardHref(board)}
                  className={`relative flex flex-1 items-center justify-center ${
                    isArch ? "bg-sky-50" : "bg-amber-50"
                  }`}
                >
                  {isArch ? (
                    <Network className="h-12 w-12 text-sky-400" />
                  ) : (
                    <Image src="/logo.svg" alt="Board" height={60} width={60} />
                  )}
                  <div className="absolute top-0 h-full w-full bg-black opacity-0 transition-opacity group-hover:opacity-50" />
                </Link>
                <div className="relative p-3">
                  <p className="max-w-[calc(100%-20px)] truncate text-[13px]">
                    {board.title}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    {isArch ? "Architecture" : "Whiteboard"} &middot; created{" "}
                    {formatDistanceToNow(board.createdAt, { addSuffix: true })}
                  </p>
                  <Actions id={board.id} title={board.title} side="right">
                    <button className="absolute right-3 top-3 px-1 py-1 opacity-0 outline-none transition-opacity group-hover:opacity-100">
                      <span className="text-lg leading-none">&#8943;</span>
                    </button>
                  </Actions>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
};

const NewBoardButton = ({
  onCreate,
}: {
  onCreate: (kind: BoardKind) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button>
        <Plus className="mr-2 h-4 w-4" />
        New board
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      <DropdownMenuItem
        className="cursor-pointer"
        onClick={() => onCreate("whiteboard")}
      >
        <Pencil className="mr-2 h-4 w-4" />
        <div>
          <p className="text-sm">Whiteboard</p>
          <p className="text-xs text-muted-foreground">
            Shapes, sticky notes, pen
          </p>
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem
        className="cursor-pointer"
        onClick={() => onCreate("arch")}
      >
        <Network className="mr-2 h-4 w-4" />
        <div>
          <p className="text-sm">Architecture</p>
          <p className="text-xs text-muted-foreground">
            Nodes, edges, diagrams
          </p>
        </div>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

export default DashboardPage;
