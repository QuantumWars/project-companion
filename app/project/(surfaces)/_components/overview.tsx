"use client";

import Link from "next/link";
import { GitCommit, Network, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import type { LinkedCommit } from "@/lib/project/git-link";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/lib/project/types";
import { useRoadmap } from "@/lib/project/use-roadmap";
import { cn } from "@/lib/utils";

const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: "bg-neutral-300",
  todo: "bg-sky-400",
  in_progress: "bg-amber-400",
  review: "bg-violet-400",
  done: "bg-emerald-500",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

/**
 * The roll-up: where the project stands across all three surfaces at once.
 *
 * Deliberately shows progress from two directions -- what the PRD says is done,
 * and what the repository shows was actually built. When those disagree, that
 * gap is the interesting thing on the page.
 */
export const Overview = ({
  root,
  diagrams,
}: {
  root?: string;
  diagrams: { id: string; title: string; type: string; kind?: string }[];
}) => {
  const roadmap = useRoadmap(root);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [commits, setCommits] = useState<LinkedCommit[]>([]);
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  const href = (path: string) => (root ? `${path}${query}` : path);

  useEffect(() => {
    fetch(`/api/project/tasks${query}`)
      .then((r) => r.json())
      .then((d) => setTasks(d.tasks ?? []))
      .catch(() => {});
    fetch(`/api/project/git${query}`)
      .then((r) => r.json())
      .then((v) => v.available && v.attribution && setCommits(v.attribution.commits))
      .catch(() => {});
  }, [query]);

  const doneFeatures = roadmap.features.filter((f) => f.status === "done").length;
  const linked = commits.filter((c) => c.taskId || c.featureId).length;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-neutral-900">Overview</h1>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Features"
          value={`${doneFeatures}/${roadmap.features.length}`}
          hint={`${roadmap.phases.length} phase${roadmap.phases.length === 1 ? "" : "s"}`}
          href={href("/project/roadmap")}
        />
        <Stat
          label="Tasks"
          value={`${tasks.filter((t) => t.status === "done").length}/${tasks.length}`}
          hint={`${tasks.filter((t) => t.status === "in_progress").length} in progress`}
          href={href("/project/tasks")}
        />
        <Stat
          label="Commits linked"
          value={commits.length ? `${linked}/${commits.length}` : "—"}
          hint={commits.length ? "recent history" : "no repository"}
          href={href("/project/git")}
        />
      </div>

      {roadmap.phases.length ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Phases
          </h2>
          <div className="space-y-3">
            {roadmap.phases.map((phase) => {
              const features = roadmap.features.filter((f) => f.phaseId === phase.id);
              const done = features.filter((f) => f.status === "done").length;
              const pct = features.length ? (done / features.length) * 100 : 0;
              return (
                <div key={phase.id}>
                  <div className="mb-1 flex items-baseline gap-x-2 text-sm">
                    <span className="font-medium text-neutral-800">{phase.name}</span>
                    <span className="text-xs text-neutral-400">
                      {done}/{features.length}
                    </span>
                    {phase.goal ? (
                      <span className="truncate text-xs text-neutral-400">{phase.goal}</span>
                    ) : null}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Work in flight
          </h2>
          <div className="space-y-1.5">
            {TASK_STATUSES.map((status) => {
              const count = tasks.filter((t) => t.status === status).length;
              return (
                <div key={status} className="flex items-center gap-x-2 text-sm">
                  <span className={cn("h-2 w-2 rounded-full", STATUS_COLOR[status])} />
                  <span className="flex-1 text-neutral-600">{STATUS_LABEL[status]}</span>
                  <span className="tabular-nums text-neutral-400">{count}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Diagrams
          </h2>
          {diagrams.length ? (
            <ul className="space-y-1.5">
              {diagrams.map((d) => (
                <li key={d.id}>
                  <Link
                    href={href(
                      d.kind === "whiteboard" ? `/project/board/${d.id}` : `/project/diagram/${d.id}`,
                    )}
                    className="flex items-center gap-x-2 text-sm text-neutral-700 hover:text-neutral-950"
                  >
                    {d.kind === "whiteboard" ? (
                      <Pencil className="h-3.5 w-3.5 text-amber-500" />
                    ) : (
                      <Network className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                    <span className="flex-1 truncate">{d.title}</span>
                    <span className="text-xs text-neutral-400">
                      {d.kind === "whiteboard" ? "whiteboard" : d.type}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-400">No diagrams yet.</p>
          )}
        </section>
      </div>

      {commits.length ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="mb-3 flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            <GitCommit className="h-3 w-3" />
            Latest commits
          </h2>
          <ul className="space-y-1">
            {commits.slice(0, 5).map((commit) => (
              <li key={commit.sha} className="flex items-baseline gap-x-2 text-sm">
                <span className="font-mono text-xs text-neutral-400">{commit.short}</span>
                <span className="min-w-0 flex-1 truncate text-neutral-700">{commit.subject}</span>
                {commit.signal ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-400">
                    {commit.signal}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};

const Stat = ({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint: string;
  href: string;
}) => (
  <Link
    href={href}
    className="rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-neutral-400"
  >
    <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
    <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">{value}</p>
    <p className="mt-0.5 text-xs text-neutral-400">{hint}</p>
  </Link>
);
