"use client";

import { formatDistanceToNow } from "date-fns";
import { GitBranch, GitCommit, Link2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildGraph } from "@/lib/project/commit-graph";
import type { AttributionSignal, LinkedCommit } from "@/lib/project/git-link";
import type { Task } from "@/lib/project/types";
import { cn } from "@/lib/utils";

type View = {
  available: boolean;
  reason?: string;
  root?: string;
  status?: { branch?: string; ahead: number; behind: number; dirty: number };
  branches?: { name: string; ahead: number; behind: number; isCurrent: boolean; lastCommitAt: string }[];
  worktrees?: { path: string; branch?: string; isMain: boolean }[];
  attribution?: {
    commits: LinkedCommit[];
    unattributed: LinkedCommit[];
  };
};

/** How a commit came to be linked, in plain words. */
const SIGNAL: Record<AttributionSignal, { label: string; hint: string; className: string }> = {
  recorded: {
    label: "recorded",
    hint: "The sha was recorded on the task explicitly.",
    className: "bg-emerald-50 text-emerald-700",
  },
  trailer: {
    label: "trailer",
    hint: "The commit message carries an archboard: <id> trailer.",
    className: "bg-sky-50 text-sky-700",
  },
  branch: {
    label: "branch",
    hint: "The branch name contains the id.",
    className: "bg-violet-50 text-violet-700",
  },
  paths: {
    label: "paths",
    hint: "The files touched fall inside the feature's declared paths. An inference, not a claim.",
    className: "bg-amber-50 text-amber-700",
  },
};

const LANE_COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6"];

export const GitSurface = ({ root }: { root?: string }) => {
  const [view, setView] = useState<View | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      try {
        const [g, t] = await Promise.all([
          fetch(`/api/project/git${query}${refresh ? (query ? "&" : "?") + "refresh=1" : ""}`).then((r) => r.json()),
          fetch(`/api/project/tasks${query}`).then((r) => r.json()),
        ]);
        setView(g);
        setTasks(t.tasks ?? []);
      } finally {
        setBusy(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const graph = useMemo(
    () => buildGraph(view?.attribution?.commits ?? []),
    [view?.attribution?.commits],
  );

  const taskTitles = useMemo(
    () => Object.fromEntries(tasks.map((t) => [t.id, t.title])),
    [tasks],
  );

  if (!view) return <p className="text-sm text-neutral-400">Reading the repository…</p>;

  if (!view.available) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
        <h2 className="text-base font-semibold text-neutral-900">No repository here</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">{view.reason}</p>
      </div>
    );
  }

  const attributed = graph.rows.length - (view.attribution?.unattributed.length ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-x-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Git</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {attributed} of {graph.rows.length} recent commits are linked to work on the board.
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

      <section className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            <GitBranch className="h-3 w-3" />
            Branches
          </h2>
          <ul className="space-y-1">
            {view.branches?.map((branch) => (
              <li key={branch.name} className="flex items-center gap-x-2 text-sm">
                <span className={cn("font-mono", branch.isCurrent ? "font-medium text-neutral-900" : "text-neutral-600")}>
                  {branch.name}
                </span>
                {branch.isCurrent ? (
                  <span className="rounded bg-emerald-50 px-1 py-0.5 text-[10px] font-medium text-emerald-700">
                    current
                  </span>
                ) : null}
                {branch.ahead ? <span className="text-xs text-emerald-600">↑{branch.ahead}</span> : null}
                {branch.behind ? <span className="text-xs text-amber-600">↓{branch.behind}</span> : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Worktrees
          </h2>
          <ul className="space-y-1">
            {view.worktrees?.map((tree) => (
              <li key={tree.path} className="flex items-baseline gap-x-2 text-sm">
                <span className="font-mono text-xs text-neutral-600">{tree.branch ?? "detached"}</span>
                {tree.isMain ? (
                  <span className="text-[10px] uppercase tracking-wide text-neutral-400">main</span>
                ) : null}
                <span className="truncate text-xs text-neutral-400">{tree.path}</span>
              </li>
            ))}
          </ul>
          {view.status?.dirty ? (
            <p className="mt-2 text-xs text-neutral-500">
              {view.status.dirty} uncommitted change{view.status.dirty === 1 ? "" : "s"} in the
              working tree.
            </p>
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <h2 className="border-b border-neutral-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          History
        </h2>
        <ul>
          {graph.rows.map((row) => (
            <li
              key={row.commit.sha}
              className="flex items-start gap-x-3 border-b border-neutral-50 px-4 py-2 last:border-0 hover:bg-neutral-50/60"
            >
              <Rail lane={row.lane} active={row.active} width={graph.width} />

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-neutral-800">{row.commit.subject}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
                  <span className="font-mono">{row.commit.short}</span>
                  <span>{row.commit.author}</span>
                  <span>{formatDistanceToNow(new Date(row.commit.at), { addSuffix: true })}</span>
                  {row.commit.insertions || row.commit.deletions ? (
                    <span className="font-mono">
                      <span className="text-emerald-600">+{row.commit.insertions}</span>{" "}
                      <span className="text-rose-500">&minus;{row.commit.deletions}</span>
                    </span>
                  ) : null}
                  {row.commit.refs.map((ref) => (
                    <span key={ref} className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[10px] text-neutral-600">
                      {ref}
                    </span>
                  ))}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-x-1.5">
                {row.commit.taskId ? (
                  <span className="max-w-[180px] truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">
                    {taskTitles[row.commit.taskId] ?? row.commit.taskId}
                  </span>
                ) : row.commit.featureId ? (
                  <span className="max-w-[180px] truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">
                    {row.commit.featureId}
                  </span>
                ) : null}
                {row.commit.signal ? (
                  <span
                    title={SIGNAL[row.commit.signal].hint}
                    className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", SIGNAL[row.commit.signal].className)}
                  >
                    {SIGNAL[row.commit.signal].label}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {view.attribution?.unattributed.length ? (
        <section className="rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-100 px-4 py-2.5">
            <h2 className="flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              <Link2 className="h-3 w-3" />
              Unattributed
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              These commits are not linked to anything on the board. Commit with an{" "}
              <code className="rounded bg-neutral-100 px-1 font-mono">archboard: &lt;taskId&gt;</code>{" "}
              trailer, or work on a branch whose name carries the id, and they link themselves.
            </p>
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {view.attribution.unattributed.map((commit) => (
              <li
                key={commit.sha}
                className="flex items-center gap-x-3 border-b border-neutral-50 px-4 py-1.5 text-sm last:border-0"
              >
                <GitCommit className="h-3 w-3 shrink-0 text-neutral-300" />
                <span className="font-mono text-xs text-neutral-400">{commit.short}</span>
                <span className="min-w-0 flex-1 truncate text-neutral-700">{commit.subject}</span>
                <span className="shrink-0 text-xs text-neutral-400">{commit.author}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};

/** The railway: a dot in this commit's lane, plus the lines passing it by. */
const Rail = ({ lane, active, width }: { lane: number; active: number[]; width: number }) => {
  const w = Math.max(1, Math.min(width, 6)) * 12 + 4;

  return (
    <svg width={w} height={38} className="mt-0.5 shrink-0" aria-hidden>
      {active
        .filter((l) => l < 6)
        .map((l) => (
          <line
            key={l}
            x1={l * 12 + 6}
            y1={0}
            x2={l * 12 + 6}
            y2={38}
            stroke={LANE_COLORS[l % LANE_COLORS.length]}
            strokeWidth={l === lane ? 2 : 1}
            opacity={l === lane ? 0.9 : 0.35}
          />
        ))}
      {lane < 6 ? (
        <circle
          cx={lane * 12 + 6}
          cy={19}
          r={4}
          fill="white"
          stroke={LANE_COLORS[lane % LANE_COLORS.length]}
          strokeWidth={2.5}
        />
      ) : null}
    </svg>
  );
};
