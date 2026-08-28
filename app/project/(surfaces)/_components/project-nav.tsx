"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { GitBranch, Network, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { StoreBadge } from "@/components/store-badge";
import { cn } from "@/lib/utils";

type DiagramRef = { id: string; title: string; type: string; kind?: string };

const SURFACES = [
  { href: "/project", label: "Overview", exact: true },
  { href: "/project/roadmap", label: "Roadmap" },
  { href: "/project/tasks", label: "Board" },
  { href: "/project/git", label: "Git" },
];

type GitChip = { branch?: string; ahead: number; behind: number; dirty: number } | null;

/**
 * The shell every project surface sits inside.
 *
 * Before this, each surface rendered its own header and the diagram nav was
 * duplicated between them. It is a client component because a Next layout
 * receives `params` but not `searchParams`, and `?root=` has to survive every
 * link or the board silently opens the wrong project.
 */
export const ProjectNav = ({
  name,
  diagrams,
}: {
  name: string;
  diagrams: DiagramRef[];
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

    // A layout cannot read `searchParams`, so the server rendered this header
    // for the project the app is running in. When `?root=` names a different
    // one, re-read it here or the header describes the wrong project.
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

  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-x-3 px-6">
        <Link href="/" className="text-sm font-semibold text-neutral-900 hover:text-neutral-600">
          {shownName}
        </Link>
        <StoreBadge />

        <nav className="ml-4 flex items-center gap-x-1">
          {SURFACES.map((surface) => {
            const active = surface.exact
              ? pathname === surface.href
              : pathname.startsWith(surface.href);
            return (
              <Link
                key={surface.href}
                href={href(surface.href)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
                )}
              >
                {surface.label}
              </Link>
            );
          })}
        </nav>

        {git?.branch ? (
          <span
            className="ml-auto flex shrink-0 items-center gap-x-1.5 rounded-md border border-neutral-200 px-2 py-1 font-mono text-xs text-neutral-600"
            title={`${git.dirty} changed file${git.dirty === 1 ? "" : "s"}`}
          >
            <GitBranch className="h-3 w-3" />
            {git.branch}
            {git.ahead ? <span className="text-emerald-600">↑{git.ahead}</span> : null}
            {git.behind ? <span className="text-amber-600">↓{git.behind}</span> : null}
            {git.dirty ? <span className="text-neutral-400">•{git.dirty}</span> : null}
          </span>
        ) : null}
      </div>

      {shownDiagrams.length ? (
        <div className="mx-auto flex max-w-7xl items-center gap-x-1 overflow-x-auto px-6 pb-2">
          {shownDiagrams.map((d) => (
            <Link
              key={d.id}
              href={href(d.kind === "whiteboard" ? `/project/board/${d.id}` : `/project/diagram/${d.id}`)}
              className="flex shrink-0 items-center gap-x-1.5 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              {d.kind === "whiteboard" ? (
                <Pencil className="h-3 w-3 text-amber-500" />
              ) : (
                <Network className="h-3 w-3 text-emerald-500" />
              )}
              {d.title}
            </Link>
          ))}
        </div>
      ) : null}
    </header>
  );
};
