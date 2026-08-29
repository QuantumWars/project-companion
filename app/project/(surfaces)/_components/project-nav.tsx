"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  GitBranch, LayoutGrid, Map, Network, Pencil, SquareKanban,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Kbd } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { CommandPalette } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";

type DiagramRef = { id: string; title: string; type: string; kind?: string };
type GitChip = { branch?: string; ahead: number; behind: number; dirty: number } | null;

const SURFACES = [
  { href: "/project", label: "Overview", icon: LayoutGrid, exact: true },
  { href: "/project/roadmap", label: "Roadmap", icon: Map },
  { href: "/project/tasks", label: "Board", icon: SquareKanban },
  { href: "/project/git", label: "Git", icon: GitBranch },
];

/**
 * The sidebar shell.
 *
 * Vertical rather than horizontal because the surfaces are lists: every row of
 * chrome across the top is a row of content lost, and the diagram list grows
 * without bound where a horizontal strip would have to scroll.
 *
 * A client component because a Next layout receives `params` but not
 * `searchParams`, and `?root=` has to survive every link or the sidebar
 * silently navigates to the wrong project.
 */
export const ProjectNav = ({
  name,
  diagrams,
  children,
}: {
  name: string;
  diagrams: DiagramRef[];
  children: React.ReactNode;
}) => {
  const pathname = usePathname();
  const params = useSearchParams();
  const root = params.get("root");
  const [git, setGit] = useState<GitChip>(null);
  const [remote, setRemote] = useState<{ name: string; diagrams: DiagramRef[] } | null>(null);

  const href = (path: string) => (root ? `${path}?root=${encodeURIComponent(root)}` : path);

  useEffect(() => {
    fetch(href("/api/project/git"))
      .then((r) => r.json())
      .then((v) => setGit(v.available ? v.status : null))
      .catch(() => {});

    // The server rendered this for the project the app runs in; `?root=` may
    // name a different one, so re-read it here or the header describes the
    // wrong project.
    if (!root) {
      setRemote(null);
      return;
    }
    fetch(href("/api/project"))
      .then((r) => r.json())
      .then((p) => p.configured && setRemote({ name: p.name, diagrams: p.diagrams ?? [] }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const shownName = remote?.name ?? name;
  const shownDiagrams = remote?.diagrams ?? diagrams;
  const active = SURFACES.find((s) =>
    s.exact ? pathname === s.href : pathname.startsWith(s.href),
  );

  return (
    <div className="flex h-full">
      <CommandPalette diagrams={shownDiagrams} root={root} />

      <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-bg-subtle">
        <Link
          href="/"
          className="flex items-center gap-x-2 px-3 py-3.5 transition-colors hover:bg-panel/60"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand text-2xs font-bold text-brand-fg">
            {shownName.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-sm font-semibold text-fg">{shownName}</span>
        </Link>

        <nav className="flex flex-col gap-y-0.5 px-2">
          {SURFACES.map((surface) => {
            const isActive = surface.exact
              ? pathname === surface.href
              : pathname.startsWith(surface.href);
            return (
              <Link
                key={surface.href}
                href={href(surface.href)}
                className={cn(
                  "flex items-center gap-x-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-panel font-medium text-fg shadow-xs"
                    : "text-fg-muted hover:bg-panel/60 hover:text-fg",
                )}
              >
                <surface.icon
                  className={cn("h-4 w-4 shrink-0", isActive ? "text-brand" : "text-fg-subtle")}
                />
                {surface.label}
              </Link>
            );
          })}
        </nav>

        {shownDiagrams.length ? (
          <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 scrollbar-slim">
            <p className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Diagrams
            </p>
            <div className="flex flex-col gap-y-0.5">
              {shownDiagrams.map((d) => {
                const to = d.kind === "whiteboard"
                  ? `/project/board/${d.id}`
                  : `/project/diagram/${d.id}`;
                return (
                  <Link
                    key={d.id}
                    href={href(to)}
                    className="flex items-center gap-x-2 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-panel/60 hover:text-fg"
                  >
                    {d.kind === "whiteboard" ? (
                      <Pencil className="h-3.5 w-3.5 shrink-0 text-status-progress" />
                    ) : (
                      <Network className="h-3.5 w-3.5 shrink-0 text-status-done" />
                    )}
                    <span className="truncate">{d.title}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <div className="border-t border-line px-3 py-2.5">
          {git?.branch ? (
            <div
              className="mb-2 flex items-center gap-x-1.5 font-mono text-2xs text-fg-muted"
              title={`${git.dirty} changed file${git.dirty === 1 ? "" : "s"}`}
            >
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{git.branch}</span>
              {git.ahead ? <span className="text-status-done">↑{git.ahead}</span> : null}
              {git.behind ? <span className="text-status-progress">↓{git.behind}</span> : null}
              {git.dirty ? <span className="text-fg-subtle">•{git.dirty}</span> : null}
            </div>
          ) : null}
          <ThemeToggle />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-x-3 border-b border-line px-5">
          <h1 className="text-sm font-semibold text-fg">{active?.label ?? "Project"}</h1>
          <button
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
              )
            }
            className="ml-auto flex items-center gap-x-1.5 rounded-md border border-line bg-panel px-2 py-1 text-xs text-fg-subtle transition-colors hover:text-fg"
          >
            Search
            <Kbd>⌘K</Kbd>
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-slim">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
};
