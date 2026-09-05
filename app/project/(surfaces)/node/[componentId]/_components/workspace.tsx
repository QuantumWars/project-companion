"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, Boxes, GitCommitHorizontal, ListChecks, SquareKanban, Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Badge, EmptyState, PageHeader, Panel, Progress, Row, SectionHeader,
  Segmented, StatusBadge, StatusDot,
} from "@/components/ui/primitives";
import type { ComponentContext } from "@/lib/project/component-context";
import type { AutonomyLevel } from "@/lib/project/bundle";
import type { TaskStatus } from "@/lib/project/types";

type Tab = "board" | "spec" | "evidence" | "health";

const TABS: { value: Tab; label: string }[] = [
  { value: "board", label: "Board" },
  { value: "spec", label: "Spec" },
  { value: "evidence", label: "Evidence" },
  { value: "health", label: "Health" },
];

const isTab = (value: string | undefined): value is Tab =>
  TABS.some((t) => t.value === value);

/**
 * One part of the system, and everything happening inside it.
 *
 * Built entirely on `primitives.tsx`. Most of that file was written and never
 * used -- `Panel`, `Row`, `PageHeader`, `SectionHeader` and `Button` were dead,
 * while four surfaces each grew their own status-colour table -- so a new
 * surface using nothing else is the cheapest way to stop that spreading.
 *
 * The tab lives in the URL. A component's evidence is the sort of thing people
 * send each other links to, and a tab held only in React state makes that link
 * land on the wrong panel.
 */
export const ComponentWorkspace = ({
  context,
  root,
  initialTab,
}: {
  context: ComponentContext;
  root?: string;
  initialTab?: string;
}) => {
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : "board");
  const component = context.component!;
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  const open = context.tasks.filter((t) => t.status !== "done");
  const criteria = context.spec.flatMap((f) => f.criteria);
  const met = criteria.filter((c) => c.done).length;

  const select = (next: Tab) => {
    setTab(next);
    // Replace rather than push: flipping between tabs is not four steps back.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="px-6 py-7">
      <PageHeader
        title={component.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {component.ancestors.map((id) => (
              <Link key={id} href={`/project/node/${id}${query}`} className="hover:text-fg">
                {id} /
              </Link>
            ))}
            <code className="text-fg-subtle">{component.id}</code>
            {component.orphaned ? <Badge tone="warning">orphaned</Badge> : null}
            {component.lifecycle !== "active" ? (
              <Badge>{component.lifecycle}</Badge>
            ) : null}
          </span>
        }
        actions={
          component.diagramId ? (
            <Link
              href={`/project/diagram/${component.diagramId}${query}`}
              className="inline-flex h-8 items-center gap-x-1.5 rounded-md bg-bg-subtle px-3 text-sm text-fg hover:bg-line/70"
            >
              <Boxes className="h-3.5 w-3.5" />
              On the canvas
            </Link>
          ) : null
        }
      />

      {/* The four numbers that say whether this part of the system is healthy:
          who is accountable, what is in flight, what is proven, what landed. */}
      <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          icon={<Users className="h-3.5 w-3.5" />}
          label="Owner"
          value={component.owner ?? "Unowned"}
          tone={component.owner ? undefined : "warning"}
        />
        <Stat
          icon={<SquareKanban className="h-3.5 w-3.5" />}
          label="In flight"
          value={String(open.length)}
        />
        <Stat
          icon={<ListChecks className="h-3.5 w-3.5" />}
          label="Criteria met"
          value={criteria.length ? `${met}/${criteria.length}` : "—"}
        />
        <Stat
          icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
          label="Commits"
          value={String(context.evidence?.total ?? 0)}
        />
      </div>

      {context.warnings.length ? (
        <Panel className="mb-6 flex items-start gap-x-2.5 p-3">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-progress" />
          <div className="min-w-0 text-[13px] text-fg-muted">
            {context.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        </Panel>
      ) : null}

      <div className="mb-4">
        <Segmented options={TABS} value={tab} onChange={select} />
      </div>

      {tab === "board" ? <Board context={context} /> : null}
      {tab === "spec" ? <Spec context={context} query={query} /> : null}
      {tab === "evidence" ? <Evidence context={context} /> : null}
      {tab === "health" ? <Health context={context} query={query} /> : null}
    </div>
  );
};

const Stat = ({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "warning";
}) => (
  <Panel className="p-3">
    <p className="mb-1 flex items-center gap-x-1.5 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
      {icon}
      {label}
    </p>
    <p
      className={cn(
        "truncate text-[15px] font-medium tabular-nums",
        tone === "warning" ? "text-status-progress" : "text-fg",
      )}
      title={value}
    >
      {value}
    </p>
  </Panel>
);

/* ---------------------------------- board --------------------------------- */

const COLUMNS: TaskStatus[] = ["backlog", "todo", "in_progress", "review", "done"];

const Board = ({ context }: { context: ComponentContext }) => {
  if (!context.tasks.length) {
    return (
      <EmptyState
        icon={<SquareKanban className="h-5 w-5" />}
        title="No work on this component yet"
      >
        Add one with <code>project-companion task add &quot;…&quot; --component {context.component!.id}</code>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      {COLUMNS.map((status) => {
        const rows = context.tasks.filter((t) => t.status === status);
        if (!rows.length) return null;
        return (
          <section key={status}>
            <SectionHeader
              title={status.replace("_", " ")}
              hint={`${rows.length}`}
            />
            <Panel className="divide-y divide-line/60">
              {rows.map((task) => (
                <Row key={task.id} interactive={false}>
                  <StatusDot status={task.status} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                    {task.title}
                  </span>
                  {task.componentId !== context.component!.id ? (
                    // Rolled up from a child, so say which one rather than
                    // implying this component owns it.
                    <Badge>{task.componentId}</Badge>
                  ) : null}
                  {task.featureId ? <Badge tone="brand">{task.featureId}</Badge> : null}
                  <code className="shrink-0 text-2xs text-fg-subtle">{task.id}</code>
                </Row>
              ))}
            </Panel>
          </section>
        );
      })}
    </div>
  );
};

/* ---------------------------------- spec ---------------------------------- */

const Spec = ({ context, query }: { context: ComponentContext; query: string }) => {
  if (!context.spec.length) {
    return (
      <EmptyState icon={<ListChecks className="h-5 w-5" />} title="No features claim this component">
        A feature belongs here when its <code>Paths:</code> fall inside this
        component&apos;s, or when it is linked to its node.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      {context.spec.map((feature) => {
        const done = feature.criteria.filter((c) => c.done).length;
        return (
          <section key={feature.id}>
            <SectionHeader
              title={feature.title}
              hint={
                <span className="flex items-center gap-x-2">
                  <StatusBadge status={feature.status as TaskStatus} />
                  <span className="tabular-nums">
                    {done}/{feature.criteria.length}
                  </span>
                </span>
              }
              actions={
                <Link
                  href={`/project/roadmap${query}`}
                  className="text-xs text-fg-muted hover:text-fg"
                >
                  Roadmap
                </Link>
              }
            />
            <Progress value={done} total={feature.criteria.length} className="mb-2" />
            <Panel className="divide-y divide-line/60">
              {feature.criteria.map((criterion) => (
                <Row key={criterion.id} interactive={false}>
                  <span
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded border text-2xs",
                      criterion.done
                        ? "border-status-done bg-status-done/15 text-status-done"
                        : "border-line text-transparent",
                    )}
                  >
                    ✓
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-[13px]",
                      criterion.done ? "text-fg-muted" : "text-fg",
                    )}
                  >
                    {criterion.text}
                  </span>
                </Row>
              ))}
            </Panel>
          </section>
        );
      })}
    </div>
  );
};

/* -------------------------------- evidence -------------------------------- */

const Evidence = ({ context }: { context: ComponentContext }) => {
  const evidence = context.evidence;

  if (!evidence || !evidence.commits.length) {
    return (
      <EmptyState
        icon={<GitCommitHorizontal className="h-5 w-5" />}
        title="Nothing has landed here yet"
      >
        {context.component!.paths?.length
          ? "No commit has touched this component's declared paths."
          : "This component declares no paths, so no commit can ever attribute to it."}
      </EmptyState>
    );
  }

  return (
    <>
      <SectionHeader
        title="Commits"
        hint={`${evidence.total} · +${evidence.insertions} −${evidence.deletions}`}
        actions={
          <span className="flex flex-wrap gap-x-1.5">
            {evidence.contributors.slice(0, 4).map((name) => (
              <Badge key={name}>{name}</Badge>
            ))}
          </span>
        }
      />
      <Panel className="divide-y divide-line/60">
        {evidence.commits.map((commit) => (
          <Row key={commit.sha} interactive={false}>
            <code className="shrink-0 text-2xs text-fg-subtle">{commit.sha}</code>
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
              {commit.subject}
            </span>
            <span className="shrink-0 text-2xs tabular-nums text-fg-subtle">
              +{commit.insertions} −{commit.deletions}
            </span>
            {/* How this commit got here, not just that it did. An inference and
                a claim are different kinds of evidence and should not look the
                same. */}
            <Badge tone={commit.signal === "paths" ? "neutral" : "brand"}>
              {commit.signal ?? "touched"}
            </Badge>
          </Row>
        ))}
      </Panel>
    </>
  );
};

/* --------------------------------- health --------------------------------- */

const AUTONOMY: { value: AutonomyLevel; label: string; hint: string }[] = [
  { value: "observe", label: "Observe", hint: "Suggest only. Changes nothing." },
  { value: "propose", label: "Propose", hint: "Writes a plan; a person runs it." },
  { value: "confirm", label: "Confirm", hint: "Acts, asking before each step." },
  { value: "autonomous", label: "Autonomous", hint: "Acts without asking." },
];

/**
 * How much rope agents get in this part of the system.
 *
 * Per component because that is where blast radius differs -- a utility module
 * can take autonomous edits and billing cannot. Progressive delegation is the
 * point: this is meant to be raised once a component has earned it, not chosen
 * once at setup.
 */
const AutonomyDial = ({
  componentId,
  current,
  query,
}: {
  componentId: string;
  current: AutonomyLevel;
  query: string;
}) => {
  const [level, setLevel] = useState(current);
  const [busy, setBusy] = useState(false);

  const set = async (next: AutonomyLevel) => {
    const previous = level;
    setLevel(next);
    setBusy(true);
    try {
      const response = await fetch(`/api/project/components/${componentId}${query}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentPolicy: { autonomy: next } }),
      });
      if (!response.ok) setLevel(previous);
    } catch {
      setLevel(previous);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Agent autonomy"
        hint={AUTONOMY.find((a) => a.value === level)?.hint}
      />
      <div className={cn("flex flex-wrap gap-x-1.5 gap-y-1.5", busy && "opacity-60")}>
        {AUTONOMY.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={busy}
            onClick={() => set(option.value)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              level === option.value
                ? "border-brand bg-brand/10 text-brand"
                : "border-line text-fg-muted hover:text-fg",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
};

const Health = ({ context, query }: { context: ComponentContext; query: string }) => {
  const component = context.component!;

  return (
    <div className="space-y-6">
      <AutonomyDial componentId={component.id} current={context.policy.autonomy} query={query} />

      <section>
        <SectionHeader title="Declared" />
        <Panel className="divide-y divide-line/60">
          <Row interactive={false}>
            <span className="w-28 shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">
              Paths
            </span>
            <span className="min-w-0 flex-1 font-mono text-xs text-fg-muted">
              {component.paths?.join(", ") || "none"}
            </span>
          </Row>
          <Row interactive={false}>
            <span className="w-28 shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">
              Children
            </span>
            <span className="min-w-0 flex-1 text-[13px]">
              {component.children.length ? (
                component.children.map((id) => (
                  <Link
                    key={id}
                    href={`/project/node/${id}${query}`}
                    className="mr-2 text-fg-muted hover:text-fg"
                  >
                    {id}
                  </Link>
                ))
              ) : (
                <span className="text-fg-subtle">none</span>
              )}
            </span>
          </Row>
        </Panel>
      </section>

      <section>
        <SectionHeader title="Recently" hint="from the event log" />
        {context.recent.length ? (
          <Panel className="divide-y divide-line/60">
            {context.recent.map((event) => (
              <Row key={event.id} interactive={false}>
                <span className="w-36 shrink-0 text-2xs tabular-nums text-fg-subtle">
                  {new Date(event.ts).toISOString().replace("T", " ").slice(0, 16)}
                </span>
                <span className="min-w-0 flex-1 text-[13px] text-fg">{event.kind}</span>
                <span className="truncate text-2xs text-fg-subtle">
                  {String(event.data.title ?? event.data.taskId ?? "")}
                </span>
              </Row>
            ))}
          </Panel>
        ) : (
          <EmptyState title="Nothing logged against this component yet" />
        )}
      </section>
    </div>
  );
};
