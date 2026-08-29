"use client";

import { useRouter } from "next/navigation";
import {
  ArrowRight, GitBranch, LayoutGrid, Map, Network, Pencil, Search, SquareKanban,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Kbd } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type Item = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
};

type DiagramRef = { id: string; title: string; type: string; kind?: string };

/**
 * ⌘K.
 *
 * A tool that sits beside a terminal should be reachable without the mouse.
 * Everything the sidebar can do is here, plus every diagram by name, so
 * navigation cost does not grow with the number of boards.
 */
export const CommandPalette = ({
  diagrams,
  root,
}: {
  diagrams: DiagramRef[];
  root: string | null;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const href = useCallback(
    (path: string) => (root ? `${path}?root=${encodeURIComponent(root)}` : path),
    [root],
  );

  const items = useMemo((): Item[] => {
    const go = (path: string) => () => {
      setOpen(false);
      router.push(href(path));
    };

    return [
      { id: "overview", label: "Overview", group: "Go to", icon: LayoutGrid, run: go("/project") },
      { id: "roadmap", label: "Roadmap", group: "Go to", icon: Map, run: go("/project/roadmap") },
      { id: "board", label: "Board", group: "Go to", icon: SquareKanban, run: go("/project/tasks") },
      { id: "git", label: "Git", group: "Go to", icon: GitBranch, run: go("/project/git") },
      ...diagrams.map((d) => ({
        id: d.id,
        label: d.title,
        hint: d.kind === "whiteboard" ? "whiteboard" : d.type,
        group: "Diagrams",
        icon: d.kind === "whiteboard" ? Pencil : Network,
        run: go(d.kind === "whiteboard" ? `/project/board/${d.id}` : `/project/diagram/${d.id}`),
      })),
    ];
  }, [diagrams, href, router]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(needle) || i.hint?.toLowerCase().includes(needle),
    );
  }, [items, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActive(0);
        return;
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[active]?.run();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-panel-raised shadow-lg animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-x-2 border-b border-line px-3">
          <Search className="h-4 w-4 shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a surface or a diagram…"
            className="h-11 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5 scrollbar-slim">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-fg-subtle">Nothing matches.</p>
          ) : (
            results.map((item, index) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {header ? (
                    <p className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
                      {header}
                    </p>
                  ) : null}
                  <button
                    data-index={index}
                    onMouseEnter={() => setActive(index)}
                    onClick={item.run}
                    className={cn(
                      "flex w-full items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                      index === active ? "bg-brand text-brand-fg" : "text-fg",
                    )}
                  >
                    <item.icon className={cn("h-3.5 w-3.5 shrink-0", index === active ? "" : "text-fg-subtle")} />
                    <span className="flex-1 truncate text-sm">{item.label}</span>
                    {item.hint ? (
                      <span className={cn("text-2xs", index === active ? "opacity-80" : "text-fg-subtle")}>
                        {item.hint}
                      </span>
                    ) : null}
                    {index === active ? <ArrowRight className="h-3 w-3 shrink-0" /> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
