"use client";

import { formatDistanceToNow } from "date-fns";
import { GitBranch, GitCommit, Link2, RefreshCw, Search, Tag, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { buildGraph } from "@/lib/project/commit-graph";
import type { AttributionSignal, LinkedCommit } from "@/lib/project/git-link";
import type { Feature, Phase, Task } from "@/lib/project/types";
import { cn } from "@/lib/utils";

import { CommitRail } from "./commit-rail";
import { Delivery } from "./delivery";

type Branch = {
  name: string; head: string; ahead: number; behind: number;
  isCurrent: boolean; lastCommitAt: string;
};

type View = {
  available: boolean;
  reason?: string;
  status?: { branch?: string; ahead: number; behind: number; dirty: number };
  branches?: Branch[];
  worktrees?: { path: string; branch?: string; isMain: boolean }[];
  tags?: { name: string; sha: string; at: string; subject?: string }[];
  attribution?: { commits: LinkedCommit[]; unattributed: LinkedCommit[] };
};

/**
 * How a commit came to be linked, in plain words.
 *
 * Showing WHICH signal produced a link matters more than it looks: three of the
 * four are claims somebody made, and the fourth is an inference. A reader who
 * cannot tell them apart cannot judge how much to trust the attribution.
 */
const SIGNAL: Record<AttributionSignal, { label: string; hint: string; className: string }> = {
  recorded: {
    label: "recorded",
    hint: "The sha was recorded on the task explicitly. Strongest signal.",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  trailer: {
    label: "trailer",
    hint: "The commit message carries a project-companion: <id> trailer.",
    className: "bg-sky-50 text-sky-700 ring-sky-200",
  },
  branch: {
    label: "branch",
    hint: "The branch that introduced this commit carries the id in its name.",
    className: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  paths: {
    label: "paths",
    hint: "The files touched fall inside a feature's declared paths. An inference, not a claim — so it never names a task.",
    className: "bg-amber-50 text-amber-700 ring-amber-200",
  },
};

type Filter = { text: string; author: string | null; signal: AttributionSignal | "none" | null };

export const GitSurface = ({ root }: { root?: string }) => {
  const [view, setView] = useState<View | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>({ text: "", author: null, signal: null });
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      try {
        const [g, t, r] = await Promise.all([
          fetch(`/api/project/git${query}${refresh ? (query ? "&" : "?") + "refresh=1" : ""}`).then((x) => x.json()),
          fetch(`/api/project/tasks${query}`).then((x) => x.json()),
          fetch(`/api/project/roadmap${query}`).then((x) => x.json()),
        ]);
        setView(g);
        setTasks(t.tasks ?? []);
        setFeatures(r.features ?? []);
        setPhases(r.phases ?? []);
      } finally {
        setBusy(false);
      }
    },
    [query],
  );

  useEffect(() => { void load(); }, [load]);

  const commits = view?.attribution?.commits ?? [];

  const labelFor = useMemo(() => {
    const taskTitles = new Map(tasks.map((t) => [t.id, t.title]));
    const featureTitles = new Map(features.map((f) => [f.id, f.title]));
    return (c: LinkedCommit) =>
      (c.taskId && taskTitles.get(c.taskId)) ??
      (c.featureId && featureTitles.get(c.featureId)) ??
      c.taskId ?? c.featureId ?? null;
  }, [tasks, features]);

  const authors = useMemo(
    () =>
      commits
        .map((c) => c.author)
        .filter((a, i, all) => all.indexOf(a) === i)
        .sort(),
    [commits],
  );

  const tagsBySha = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tag of view?.tags ?? []) {
      map.set(tag.sha, [...(map.get(tag.sha) ?? []), tag.name]);
    }
    return map;
  }, [view?.tags]);

  const tipShas = useMemo(
    () => new Set([...(view?.branches ?? []).map((b) => b.head), ...(view?.tags ?? []).map((t) => t.sha)]),
    [view?.branches, view?.tags],
  );

  /**
   * Filtering hides rows but never re-lays out the graph.
   *
   * Recomputing lanes over a filtered subset would connect commits that are not
   * actually parent and child, drawing a history that never happened. Matching
   * rows are highlighted and the rest dimmed, so the shape stays true.
   */
  const graph = useMemo(() => buildGraph(commits), [commits]);

  const matches = useCallback(
    (c: LinkedCommit) => {
      const needle = filter.text.trim().toLowerCase();
      if (needle) {
        const hay = `${c.subject} ${c.body} ${c.short} ${c.author} ${c.paths.join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (filter.author && c.author !== filter.author) return false;
      if (filter.signal === "none" && c.signal) return false;
      if (filter.signal && filter.signal !== "none" && c.signal !== filter.signal) return false;
      return true;
    },
    [filter],
  );

  const shown = commits.filter(matches).length;
  const isFiltering = Boolean(filter.text.trim() || filter.author || filter.signal);

  if (!view) return <p className="text-sm text-neutral-400">Reading the repository…</p>;

  if (!view.available) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
        <h2 className="text-base font-semibold text-neutral-900">No repository here</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">{view.reason}</p>
      </div>
    );
  }

  const linked = commits.filter((c) => c.taskId || c.featureId).length;
  const detail = selected ? commits.find((c) => c.sha === selected) : undefined;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Git</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {linked} of {commits.length} recent commits are linked to work on the board.
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={busy}
          className="flex shrink-0 items-center gap-x-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
          Rescan
        </button>
      </div>

      <section className="grid gap-3 md:grid-cols-3">
        <Panel icon={<GitBranch className="h-3 w-3" />} title="Branches">
          <ul className="space-y-1">
            {view.branches?.map((b) => (
              <li key={b.name} className="flex items-center gap-x-2 text-sm">
                <span className={cn("font-mono text-xs", b.isCurrent ? "font-medium text-neutral-900" : "text-neutral-600")}>
                  {b.name}
                </span>
                {b.isCurrent ? <Pill className="bg-emerald-50 text-emerald-700">current</Pill> : null}
                {b.ahead ? <span className="text-xs text-emerald-600">↑{b.ahead}</span> : null}
                {b.behind ? <span className="text-xs text-amber-600">↓{b.behind}</span> : null}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel icon={<Tag className="h-3 w-3" />} title="Releases">
          {view.tags?.length ? (
            <ul className="space-y-1">
              {view.tags.slice(0, 6).map((t) => (
                <li key={t.name} className="flex items-baseline gap-x-2 text-sm">
                  <span className="font-mono text-xs text-neutral-800">{t.name}</span>
                  <span className="truncate text-xs text-neutral-400">{t.subject ?? ""}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-neutral-400">
              No tags. A tag is how the repository says what shipped.
            </p>
          )}
        </Panel>

        <Panel title="Working tree">
          <ul className="space-y-1">
            {view.worktrees?.map((w) => (
              <li key={w.path} className="flex items-baseline gap-x-2 text-sm">
                <span className="font-mono text-xs text-neutral-600">{w.branch ?? "detached"}</span>
                {w.isMain ? <span className="text-[10px] uppercase text-neutral-400">main</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            {view.status?.dirty
              ? `${view.status.dirty} uncommitted change${view.status.dirty === 1 ? "" : "s"}.`
              : "Clean."}
          </p>
        </Panel>
      </section>

      <Delivery features={features} phases={phases} tasks={tasks} commits={commits} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
          <Input
            value={filter.text}
            onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
            placeholder="Filter by message, author or path…"
            className="h-8 w-72 pl-7 text-sm"
          />
        </div>

        <select
          value={filter.author ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, author: e.target.value || null }))}
          className="h-8 rounded-md border border-neutral-200 px-2 text-xs outline-none focus:border-neutral-400"
        >
          <option value="">All authors</option>
          {authors.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>

        <div className="flex items-center gap-x-0.5 rounded-md border border-neutral-200 bg-white p-0.5">
          {([null, "recorded", "trailer", "branch", "paths", "none"] as const).map((s) => (
            <button
              key={s ?? "all"}
              onClick={() => setFilter((f) => ({ ...f, signal: s }))}
              title={s && s !== "none" ? SIGNAL[s].hint : undefined}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium capitalize transition-colors",
                filter.signal === s ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100",
              )}
            >
              {s === null ? "All" : s === "none" ? "Unlinked" : s}
            </button>
          ))}
        </div>

        {isFiltering ? (
          <button
            onClick={() => setFilter({ text: "", author: null, signal: null })}
            className="flex items-center gap-x-1 text-xs text-neutral-500 hover:text-neutral-900"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        ) : null}

        <span className="ml-auto text-xs text-neutral-400">
          {isFiltering ? `${shown} of ${commits.length}` : `${commits.length} commits`}
        </span>
      </div>

      <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <ul>
          {graph.rows.map((row) => {
            const c = row.commit;
            const dimmed = isFiltering && !matches(c);
            const tags = tagsBySha.get(c.sha) ?? [];
            const label = labelFor(c);

            return (
              <li key={c.sha}>
                <button
                  onClick={() => setSelected(selected === c.sha ? null : c.sha)}
                  className={cn(
                    "flex w-full items-stretch gap-x-3 border-b border-neutral-50 px-3 text-left last:border-0 hover:bg-neutral-50/70",
                    selected === c.sha && "bg-sky-50/60",
                  )}
                >
                  <CommitRail row={row} width={graph.width} isTip={tipShas.has(c.sha)} dimmed={dimmed} />

                  <span className={cn("min-w-0 flex-1 self-center py-1.5", dimmed && "opacity-35")}>
                    <span className="flex items-center gap-x-2">
                      <span className="truncate text-sm text-neutral-800">{c.subject}</span>
                      {tags.map((t) => (
                        <Pill key={t} className="bg-amber-50 text-amber-800 ring-amber-200">
                          <Tag className="mr-0.5 inline h-2.5 w-2.5" />{t}
                        </Pill>
                      ))}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
                      <span className="font-mono">{c.short}</span>
                      <span>{c.author}</span>
                      <span>{formatDistanceToNow(new Date(c.at), { addSuffix: true })}</span>
                      {c.insertions || c.deletions ? (
                        <span className="font-mono">
                          <span className="text-emerald-600">+{c.insertions}</span>{" "}
                          <span className="text-rose-500">&minus;{c.deletions}</span>
                        </span>
                      ) : null}
                      {c.refs.filter((r) => !tags.includes(r)).map((r) => (
                        <Pill key={r} className="bg-neutral-100 text-neutral-600 ring-neutral-200">{r}</Pill>
                      ))}
                    </span>
                  </span>

                  <span className={cn("flex shrink-0 items-center gap-x-1.5 self-center", dimmed && "opacity-35")}>
                    {label ? (
                      <span className="max-w-[200px] truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">
                        {label}
                      </span>
                    ) : null}
                    {c.signal ? (
                      <span
                        title={SIGNAL[c.signal].hint}
                        className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium ring-1", SIGNAL[c.signal].className)}
                      >
                        {SIGNAL[c.signal].label}
                      </span>
                    ) : null}
                  </span>
                </button>

                {selected === c.sha ? <CommitDetail commit={c} label={label} /> : null}
              </li>
            );
          })}
        </ul>
      </section>

      {view.attribution?.unattributed.length ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            <Link2 className="h-3 w-3" />
            {view.attribution.unattributed.length} unlinked
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Commit with a{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono">project-companion: &lt;taskId&gt;</code>{" "}
            trailer, or work on a branch whose name carries the id, and they link themselves.
            To attach one after the fact:{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono">
              project-companion task done &lt;id&gt; --commit &lt;sha&gt;
            </code>
          </p>
        </section>
      ) : null}
    </div>
  );
};

const CommitDetail = ({ commit, label }: { commit: LinkedCommit; label: string | null }) => (
  <div className="border-b border-neutral-100 bg-neutral-50/60 px-3 py-3 pl-16">
    {commit.body ? (
      <pre className="mb-2 whitespace-pre-wrap font-sans text-xs text-neutral-600">{commit.body}</pre>
    ) : null}
    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
      {commit.paths.length} file{commit.paths.length === 1 ? "" : "s"} changed
    </p>
    <ul className="max-h-48 space-y-0.5 overflow-y-auto">
      {commit.paths.map((path) => (
        <li key={path} className="font-mono text-xs text-neutral-600">{path}</li>
      ))}
    </ul>
    {label ? (
      <p className="mt-2 text-xs text-neutral-500">
        Linked to <span className="font-medium text-neutral-800">{label}</span>
      </p>
    ) : null}
  </div>
);

const Panel = ({
  icon, title, children,
}: { icon?: React.ReactNode; title: string; children: React.ReactNode }) => (
  <div className="rounded-lg border border-neutral-200 bg-white p-4">
    <h2 className="mb-2 flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {icon}
      {title}
    </h2>
    {children}
  </div>
);

const Pill = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", className)}>
    {children}
  </span>
);
