"use client";

import Link from "next/link";
import { GitCommit, Network, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import type { LinkedCommit } from "@/lib/project/git-link";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/lib/project/types";
import { useRoadmap } from "@/lib/project/use-roadmap";
import { cn } from "@/lib/utils";
import { Panel, Row, StatusDot, STATUS_COLOR, STATUS_LABEL } from "@/components/ui/primitives";

/**
 * What to look at first, and where work is piling up.
 *
 * Above the roll-up rather than below it, because a landing page's job is to
 * answer "what now" and a progress bar has never answered that. The ranking is
 * computed on the server -- it needs the dependency graph for blast radius,
 * which is a source walk the browser has no business doing.
 */
const WhatNext = ({ root }: { root?: string }) => {
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  useEffect(() => {
    fetch(`/api/project/flow${query}`)
      .then((r) => r.json())
      .then(setFlow)
      .catch(() => {});
  }, [query]);

  if (!flow?.configured || !flow.attention.length) return null;

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-x-4">
        <h2 className="text-[13px] font-medium text-fg">Look at first</h2>
        <span className="text-2xs text-fg-subtle">
          {flow.summary.inFlight} in flight
          {flow.summary.reworked ? ` · ${flow.summary.reworked} sent back` : ""}
        </span>
      </div>

      <div className="divide-y divide-line/60">
        {flow.attention.map((item) => (
          <Row key={item.taskId} interactive={false} className="px-0">
            <StatusDot status={item.status} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{item.title}</span>
            {/* The reasons, not just the rank. A list nobody can argue with is
                a list nobody trusts. */}
            <span className="hidden truncate text-2xs text-fg-subtle sm:block sm:max-w-[46%]">
              {item.why.join(" · ")}
            </span>
          </Row>
        ))}
      </div>

      {flow.summary.queues.length ? (
        <p className="mt-3 text-2xs text-fg-subtle">
          {flow.summary.queues
            .map((q) => `${STATUS_LABEL[q.status]}: ${q.count}, oldest ${days(q.oldestMs)}`)
            .join(" · ")}
        </p>
      ) : null}
    </Panel>
  );
};

type FlowResponse = {
  configured: boolean;
  summary: {
    inFlight: number;
    reworked: number;
    queues: { status: TaskStatus; count: number; oldestMs: number }[];
  };
  attention: { taskId: string; title: string; status: TaskStatus; why: string[] }[];
};

const days = (ms: number) =>
  ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;

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
      <h1 className="text-[19px] font-semibold leading-tight text-fg">Overview</h1>

      <WhatNext root={root} />

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
        <section className="rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60 p-4">
          <h2 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
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
                    <span className="font-medium text-fg">{phase.name}</span>
                    <span className="text-xs text-fg-subtle">
                      {done}/{features.length}
                    </span>
                    {phase.goal ? (
                      <span className="truncate text-xs text-fg-subtle">{phase.goal}</span>
                    ) : null}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-subtle">
                    <div className="h-full bg-status-done" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60 p-4">
          <h2 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Work in flight
          </h2>
          <div className="space-y-1.5">
            {TASK_STATUSES.map((status) => {
              const count = tasks.filter((t) => t.status === status).length;
              return (
                <div key={status} className="flex items-center gap-x-2 text-sm">
                  <span className={cn("h-2 w-2 rounded-full", STATUS_COLOR[status])} />
                  <span className="flex-1 text-fg-muted">{STATUS_LABEL[status]}</span>
                  <span className="tabular-nums text-fg-subtle">{count}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60 p-4">
          <h2 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
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
                    className="flex items-center gap-x-2 text-sm text-fg hover:text-fg">
                    {d.kind === "whiteboard" ? (
                      <Pencil className="h-3.5 w-3.5 text-status-progress" />
                    ) : (
                      <Network className="h-3.5 w-3.5 text-status-done" />
                    )}
                    <span className="flex-1 truncate">{d.title}</span>
                    <span className="text-xs text-fg-subtle">
                      {d.kind === "whiteboard" ? "whiteboard" : d.type}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-subtle">No diagrams yet.</p>
          )}
        </section>
      </div>

      {commits.length ? (
        <section className="rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60 p-4">
          <h2 className="mb-3 flex items-center gap-x-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            <GitCommit className="h-3 w-3" />
            Latest commits
          </h2>
          <ul className="space-y-1">
            {commits.slice(0, 5).map((commit) => (
              <li key={commit.sha} className="flex items-baseline gap-x-2 text-sm">
                <span className="font-mono text-xs text-fg-subtle">{commit.short}</span>
                <span className="min-w-0 flex-1 truncate text-fg">{commit.subject}</span>
                {commit.signal ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">
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
    className="rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60 p-4 transition-colors hover:bg-bg-subtle">
    <p className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{label}</p>
    <p className="mt-1.5 text-[26px] font-semibold leading-none text-fg">{value}</p>
    <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>
  </Link>
);
