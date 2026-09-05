"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Bot, Boxes, GitBranch, LayoutGrid, Map, Network, Pencil, SquareKanban,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Kbd } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { CommandPalette } from "./command-palette";
import { NewDiagram } from "./new-diagram";
import { ThemeToggle } from "./theme-toggle";

type DiagramRef = { id: string; title: string; type: string; kind?: string };
type GitChip = { branch?: string; ahead: number; behind: number; dirty: number } | null;

/** Only what the sidebar draws; the workspace reads the rest. */
type CatalogNode = {
  id: string;
  title: string;
  orphaned?: boolean;
  children?: CatalogNode[];
};

type SidebarComponent = {
  id: string;
  title: string;
  depth: number;
  orphaned?: boolean;
  open: number;
};

const SURFACES = [
  { href: "/project", label: "Overview", icon: LayoutGrid, exact: true },
  { href: "/project/roadmap", label: "Roadmap", icon: Map },
  { href: "/project/tasks", label: "Board", icon: SquareKanban },
  { href: "/project/agents", label: "Agents", icon: Bot },
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
  const [tree, setTree] = useState<CatalogNode[]>([]);
  const [counts, setCounts] = useState<Record<string, { open: number }>>({});

  const href = (path: string) => (root ? `${path}?root=${encodeURIComponent(root)}` : path);

  useEffect(() => {
    fetch(href("/api/project/git"))
      .then((r) => r.json())
      .then((v) => setGit(v.available ? v.status : null))
      .catch(() => {});

    fetch(href("/api/project/components"))
      .then((r) => r.json())
      .then((v) => {
        setTree(v.tree ?? []);
        setCounts(v.counts ?? {});
      })
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

  // Flattened here rather than rendered recursively: the sidebar needs depth
  // for indentation, not a nested DOM, and one list keeps the keyboard order
  // matching the visual one.
  const components = useMemo(() => {
    const walk = (nodes: CatalogNode[], depth: number): SidebarComponent[] =>
      nodes.flatMap((n) => [
        { id: n.id, title: n.title, depth, orphaned: n.orphaned, open: counts[n.id]?.open ?? 0 },
        ...walk(n.children ?? [], depth + 1),
      ]);
    return walk(tree, 0);
  }, [tree, counts]);
  const active = SURFACES.find((s) =>
    s.exact ? pathname === s.href : pathname.startsWith(s.href),
  );

  return (
    <div className="flex h-full">
      <CommandPalette diagrams={shownDiagrams} root={root} />

      {/*
        The sidebar sits on the page ground, not on its own tinted panel. A
        second background colour behind the nav is what makes an app look like
        a dashboard template; the separation reads perfectly well from the
        hairline and the content's own surface.
      */}
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-line/70">
        <Link
          href="/"
          className="mx-2 mt-2 flex items-center gap-x-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-bg-subtle"
        >
          <Image src="/logo.svg" alt="" height={22} width={22} className="shrink-0" priority />
          <span className="truncate text-[13px] font-medium text-fg">{shownName}</span>
        </Link>

        <nav className="mt-3 flex flex-col gap-y-px px-2">
          {SURFACES.map((surface) => {
            const isActive = surface.exact
              ? pathname === surface.href
              : pathname.startsWith(surface.href);
            return (
              <Link
                key={surface.href}
                href={href(surface.href)}
                className={cn(
                  "flex items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors duration-100",
                  isActive
                    ? "bg-bg-subtle font-medium text-fg"
                    : "text-fg-muted hover:bg-bg-subtle/70 hover:text-fg",
                )}
              >
                <surface.icon
                  className={cn(
                    "h-[15px] w-[15px] shrink-0 transition-colors",
                    isActive ? "text-brand" : "text-fg-subtle group-hover:text-fg-muted",
                  )}
                />
                {surface.label}
              </Link>
            );
          })}
        </nav>

        {/*
          Components before diagrams, because a component is what the work hangs
          off and a diagram is one drawing of it. Indented by depth so the
          containment tree reads at a glance rather than as a flat list.
        */}
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 scrollbar-slim">
          {components.length ? (
            <div className="mb-5">
              <p className="px-2 pb-1 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
                Components
              </p>
              <div className="flex flex-col gap-y-px">
                {components.map((c) => (
                  <Link
                    key={c.id}
                    href={href(`/project/node/${c.id}`)}
                    style={{ paddingLeft: `${8 + c.depth * 12}px` }}
                    className={cn(
                      "flex items-center gap-x-2 rounded-lg py-1.5 pr-2 text-[13px] transition-colors duration-100",
                      pathname === `/project/node/${c.id}`
                        ? "bg-bg-subtle font-medium text-fg"
                        : "text-fg-muted hover:bg-bg-subtle/70 hover:text-fg",
                    )}
                  >
                    <Boxes
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        c.orphaned ? "text-status-progress" : "text-brand",
                      )}
                    />
                    <span className="truncate">{c.title}</span>
                    {c.open ? (
                      <span className="ml-auto shrink-0 text-2xs tabular-nums text-fg-subtle">
                        {c.open}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between px-2 pb-1">
            <p className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">
              Diagrams
            </p>
            <NewDiagram root={root} />
          </div>

          {shownDiagrams.length ? (
            <div className="flex flex-col gap-y-px">
              {shownDiagrams.map((d) => {
                const to = d.kind === "whiteboard"
                  ? `/project/board/${d.id}`
                  : `/project/diagram/${d.id}`;
                return (
                  <Link
                    key={d.id}
                    href={href(to)}
                    className="flex items-center gap-x-2 rounded-lg px-2 py-1.5 text-[13px] text-fg-muted transition-colors duration-100 hover:bg-bg-subtle/70 hover:text-fg"
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
          ) : (
            <p className="px-2 py-1 text-xs leading-relaxed text-fg-subtle">
              None yet.
            </p>
          )}
        </div>

        <div className="px-3 pb-3 pt-2">
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
        <header className="flex h-12 shrink-0 items-center gap-x-3 px-7">
          <span className="text-[13px] font-medium text-fg-muted">
            {active?.label ?? "Project"}
          </span>
          <button
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
              )
            }
            className="ml-auto flex items-center gap-x-1.5 rounded-lg bg-bg-subtle px-2 py-1 text-xs text-fg-subtle transition-colors hover:text-fg"
          >
            Search
            <Kbd>⌘K</Kbd>
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-7 pb-16 pt-1 scrollbar-slim">
          <div className="mx-auto max-w-5xl animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
};
