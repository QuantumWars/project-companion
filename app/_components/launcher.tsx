"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Clock, Database, FolderGit2, GitBranch, Grid3x3, Map, Network,
  Pencil, Plus, SquareKanban, Terminal, Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Badge, EmptyState, Progress, StatusDot,
} from "@/components/ui/primitives";
import { NewDiagramButton } from "./new-diagram-button";
import type { ProjectSummary } from "@/lib/project/summary";
import { TASK_STATUSES } from "@/lib/project/types";
import {
  boardHref, boardKind, createBoard, useBoards, type BoardKind,
} from "@/lib/local-boards";
import { cn } from "@/lib/utils";

/**
 * The launcher, in the shape of an editor's start window.
 *
 * The organising idea is borrowed from VS Code: what you want on opening is not
 * a feature tour but a way back into the thing you were last working on. So
 * recent projects are the page, and everything else is secondary.
 *
 * What differs is the row. An editor can only tell you a folder's name and
 * path, because a folder is opaque to it. A project here is not: it knows how
 * many architecture diagrams and schemas it holds, how far the roadmap has got,
 * and whether the working tree is dirty. That is the difference worth showing.
 */

/** Diagram types grouped into the handful of things people actually look for. */
const FAMILY = {
  architecture: { label: "architecture", icon: Network, types: ["architecture", "network", "block"] },
  schema: { label: "schema", icon: Database, types: ["erd"] },
  flow: { label: "flow", icon: Workflow, types: ["flowchart", "bpmn", "dfd", "sitemap", "orgchart", "mindmap"] },
  model: { label: "model", icon: Grid3x3, types: ["uml", "venn"] },
} as const;

const familyCounts = (byType: ProjectSummary["diagrams"]["byType"]) =>
  Object.entries(FAMILY)
    .map(([key, family]) => ({
      key,
      label: family.label,
      icon: family.icon,
      count: family.types.reduce(
        (n, t) => n + (byType[t as keyof typeof byType] ?? 0),
        0,
      ),
    }))
    .filter((f) => f.count > 0);

export const Launcher = () => {
  const router = useRouter();
  const boards = useBoards();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  const currentProject = useMemo(
    () => projects?.find((p) => p.path === current) ?? null,
    [projects, current],
  );

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => {
        setProjects(d.projects ?? []);
        setCurrent(d.current ?? null);
      })
      .catch(() => setProjects([]));
  }, []);

  const onCreate = (kind: BoardKind) => {
    const board = createBoard(kind === "arch" ? "Untitled diagram" : "Untitled", kind);
    router.push(boardHref(board));
  };

  return (
    <main className="mx-auto flex min-h-full max-w-4xl flex-col px-8 py-24 animate-fade-in">
      <header className="mb-14 flex items-center gap-x-3.5">
        <Image src="/logo.svg" alt="" height={34} width={34} priority />
        <div>
          <h1 className="text-[26px] font-semibold leading-none text-fg">Project Companion</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
            Project management that runs with your coding agent
          </p>
        </div>
      </header>

      <div className="grid gap-x-16 gap-y-12 md:grid-cols-[minmax(0,1fr)_220px]">
        <section>
          <h2 className="mb-2.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
            Recent projects
          </h2>

          {projects === null ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="h-[76px] animate-pulse rounded-xl bg-bg-subtle" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={<FolderGit2 className="h-7 w-7" />}
              title="No projects indexed yet">
              <p>
                Run <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-xs">
                  npx project-companion init
                </code>{" "}
                inside a repository. It writes a store your agent can read and
                registers the project here.
              </p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line/50">
              {projects.map((project) => (
                <ProjectRow
                  key={project.path}
                  project={project}
                  isCurrent={project.path === current}
                />
              ))}
            </ul>
          )}

          {boards.length ? (
            <>
              <h2 className="mb-2.5 mt-12 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
                Local boards
              </h2>
              <p className="mb-3 text-xs text-fg-subtle">
                Kept in this browser only. Your agent cannot see these.
              </p>
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {boards.map((board) => {
                  const isArch = boardKind(board) === "arch";
                  return (
                    <li key={board.id}>
                      <Link
                        href={boardHref(board)}
                        className="flex items-center gap-x-2.5 rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60 px-3 py-2.5 transition-colors hover:bg-bg-subtle">
                        {isArch ? (
                          <Network className="h-4 w-4 shrink-0 text-status-done" />
                        ) : (
                          <Pencil className="h-4 w-4 shrink-0 text-status-progress" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-fg">{board.title}</span>
                          <span className="block text-2xs text-fg-subtle">
                            {formatDistanceToNow(board.createdAt, { addSuffix: true })}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </section>

        <aside>
          <h2 className="mb-2.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
            Start
          </h2>
          {currentProject ? (
            <div className="mb-5">
              <NewDiagramButton root={null} projectName={currentProject.name} />
            </div>
          ) : null}

          {/*
            Deliberately labelled and separated. A diagram made in a project is
            a file the agent can read; a scratch board lives in this browser and
            is invisible to it. Presenting both as the same kind of "new" is how
            someone ends up with work the agent will never see.
          */}
          <p className="mb-1.5 text-2xs text-fg-subtle">Scratch, in this browser</p>
          <div className="flex flex-col gap-y-0.5">
            <StartAction
              icon={Network}
              label="Architecture diagram"
              onClick={() => onCreate("arch")}
            />
            <StartAction
              icon={Pencil}
              label="Whiteboard"
              onClick={() => onCreate("whiteboard")}
            />
          </div>

          <h2 className="mb-2.5 mt-9 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
            Add a project
          </h2>
          <p className="mb-2 flex items-center gap-x-1.5 text-xs text-fg-muted">
            <Terminal className="h-3 w-3 shrink-0" />
            In any repository
          </p>
          <code className="block select-all rounded-lg bg-bg-subtle px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
            npx project-companion init
          </code>
          <p className="mt-2 text-2xs leading-relaxed text-fg-subtle">
            Creates the store, writes the agent skill, and lists the project here.
          </p>
        </aside>
      </div>
    </main>
  );
};

const StartAction = ({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className="-mx-2 flex items-center gap-x-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-brand transition-colors duration-100 hover:bg-brand-subtle">
    <Icon className="h-3.5 w-3.5 shrink-0" />
    {label}
  </button>
);

const ProjectRow = ({
  project,
  isCurrent,
}: {
  project: ProjectSummary;
  isCurrent: boolean;
}) => {
  const families = useMemo(
    () => familyCounts(project.diagrams.byType),
    [project.diagrams.byType],
  );

  // `?root=` is what lets one running server open a project it is not inside.
  const href = (path: string) =>
    isCurrent ? path : `${path}?root=${encodeURIComponent(project.path)}`;

  const active = project.tasks.byStatus.in_progress + project.tasks.byStatus.review;

  if (!project.present) {
    return (
      <li className="rounded-xl bg-bg-subtle px-4 py-3">
        <p className="text-sm text-fg-muted">{project.name}</p>
        <p className="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{project.path}</p>
        <p className="mt-1.5 text-xs text-status-progress">
          The store has moved or been deleted. Run{" "}
          <code className="font-mono">project-companion projects forget</code> to drop it.
        </p>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={href("/project")}
        className="group -mx-3 block rounded-xl px-3 py-3 transition-colors duration-100 hover:bg-bg-subtle"
      >
        <div className="flex items-baseline gap-x-2">
          <span className="truncate text-[15px] font-medium text-fg">{project.name}</span>
          {isCurrent ? <Badge tone="brand">open here</Badge> : null}
          <span className="ml-auto flex shrink-0 items-center gap-x-1 text-2xs text-fg-subtle">
            <Clock className="h-2.5 w-2.5" />
            {formatDistanceToNow(new Date(project.lastOpened), { addSuffix: true })}
          </span>
        </div>

        <p className="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{project.path}</p>

        {/* What kind of data this project actually holds. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
          {families.map((family) => (
            <span key={family.key} className="flex items-center gap-x-1">
              <family.icon className="h-3 w-3 text-fg-subtle" />
              {family.count} {family.label}
              {family.count === 1 ? "" : "s"}
            </span>
          ))}
          {project.whiteboards ? (
            <span className="flex items-center gap-x-1">
              <Pencil className="h-3 w-3 text-fg-subtle" />
              {project.whiteboards} whiteboard{project.whiteboards === 1 ? "" : "s"}
            </span>
          ) : null}
          {!families.length && !project.whiteboards ? (
            <span className="text-fg-subtle">No diagrams yet</span>
          ) : null}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          {project.features.total ? (
            <span className="flex items-center gap-x-2">
              <Map className="h-3 w-3 shrink-0 text-fg-subtle" />
              <Progress
                value={project.features.done}
                total={project.features.total}
                className="w-20"/>
              <span className="text-2xs tabular-nums text-fg-muted">
                {project.features.done}/{project.features.total} features
              </span>
            </span>
          ) : null}

          {project.tasks.total ? (
            <span className="flex items-center gap-x-1.5 text-2xs text-fg-muted">
              <SquareKanban className="h-3 w-3 shrink-0 text-fg-subtle" />
              <span className="flex items-center gap-x-1">
                {TASK_STATUSES.filter((s) => project.tasks.byStatus[s] > 0).map((s) => (
                  <span key={s} className="flex items-center gap-x-0.5" title={s}>
                    <StatusDot status={s} />
                    <span className="tabular-nums">{project.tasks.byStatus[s]}</span>
                  </span>
                ))}
              </span>
              {active ? <span className="text-fg-subtle">· {active} in flight</span> : null}
            </span>
          ) : null}

          {project.git?.branch ? (
            <span
              className="flex items-center gap-x-1 font-mono text-2xs text-fg-subtle"
              title={`${project.git.dirty} uncommitted change${project.git.dirty === 1 ? "" : "s"}`}
            >
              <GitBranch className="h-3 w-3" />
              {project.git.branch}
              {project.git.ahead ? <span className="text-status-done">↑{project.git.ahead}</span> : null}
              {project.git.dirty ? <span>•{project.git.dirty}</span> : null}
            </span>
          ) : null}
        </div>

        {/* Deep links, so the launcher can drop you at the right surface. */}
        <div className="mt-3 flex flex-wrap gap-x-1 gap-y-1 opacity-0 transition-opacity group-hover:opacity-100">
          {[
            { to: "/project/roadmap", label: "Roadmap", show: project.features.total > 0 },
            { to: "/project/tasks", label: "Board", show: project.tasks.total > 0 },
            { to: "/project/git", label: "Git", show: Boolean(project.git) },
          ]
            .filter((l) => l.show)
            .map((link) => (
              <span
                key={link.to}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.location.href = href(link.to);
                }}
                className="rounded bg-bg-subtle px-1.5 py-0.5 text-2xs text-fg-muted hover:bg-bg-subtle hover:text-fg">
                {link.label}
              </span>
            ))}
        </div>
      </Link>
    </li>
  );
};
