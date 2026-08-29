"use client";

import Link from "next/link";
import { GitBranch, GitCommit, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Segmented, StatusDot, TextInput } from "@/components/ui/primitives";
import type { LinkedCommit } from "@/lib/project/git-link";
import { TASK_STATUSES, type Feature, type Phase, type Task, type TaskStatus } from "@/lib/project/types";
import { useRoadmap } from "@/lib/project/use-roadmap";
import { useTasks } from "@/lib/project/use-tasks";
import { cn } from "@/lib/utils";

const COLUMN_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  backlog: "bg-status-backlog",
  todo: "bg-status-todo",
  in_progress: "bg-status-progress",
  review: "bg-status-review",
  done: "bg-status-done",
};

type NodeLookup = Record<string, { label: string; diagramId: string }>;
type Grouping = "none" | "phase" | "feature";

export const Board = ({ nodeLookup, root }: { nodeLookup: NodeLookup; root?: string }) => {
  const { tasks, loading, configured, move, create, update, remove } = useTasks(root);
  const roadmap = useRoadmap(root);

  const [grouping, setGrouping] = useState<Grouping>("none");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [git, setGit] = useState<Record<string, LinkedCommit[]>>({});

  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  useEffect(() => {
    fetch(`/api/project/git${query}`)
      .then((r) => r.json())
      .then((v) => v.available && v.attribution && setGit(v.attribution.byTask))
      .catch(() => {});
  }, [query]);

  const features = useMemo(
    () => Object.fromEntries(roadmap.features.map((f) => [f.id, f])),
    [roadmap.features],
  );
  const phases = useMemo(
    () => Object.fromEntries(roadmap.phases.map((p) => [p.id, p])),
    [roadmap.phases],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        (t.featureId && features[t.featureId]?.title.toLowerCase().includes(needle)),
    );
  }, [tasks, filter, features]);

  /**
   * Swimlanes are the point of this board: one row per phase or per feature, so
   * "which segment of the PRD is in flight" is answerable at a glance rather
   * than by reading every card.
   */
  const lanes = useMemo((): { key: string; label: string; hint?: string; tasks: Task[] }[] => {
    if (grouping === "none") return [{ key: "all", label: "", tasks: visible }];

    if (grouping === "phase") {
      const rows: { key: string; label: string; hint?: string; tasks: Task[] }[] =
        roadmap.phases.map((phase) => ({
          key: phase.id,
          label: phase.name,
          hint: phase.goal,
          tasks: visible.filter((t) => laneOfPhase(t, features) === phase.id),
        }));
      const rest = visible.filter((t) => !laneOfPhase(t, features));
      if (rest.length) rows.push({ key: "_", label: "No phase", tasks: rest });
      return rows.filter((r) => r.tasks.length);
    }

    const rows: { key: string; label: string; hint?: string; tasks: Task[] }[] =
      roadmap.features.map((feature) => ({
        key: feature.id,
        label: feature.title,
        hint: `${feature.acceptance.filter((c) => c.done).length}/${feature.acceptance.length} criteria`,
        tasks: visible.filter((t) => t.featureId === feature.id),
      }));
    const rest = visible.filter((t) => !t.featureId);
    if (rest.length) rows.push({ key: "_", label: "No feature", tasks: rest });
    return rows.filter((r) => r.tasks.length);
  }, [grouping, visible, roadmap.phases, roadmap.features, features]);

  if (!loading && !configured) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong bg-panel p-8 text-center">
        <h2 className="text-base font-semibold text-fg">No project here</h2>
        <p className="mt-2 text-sm text-fg-muted">
          Run <code className="rounded bg-bg-subtle px-1 font-mono text-xs">project-companion init</code>{" "}
          in a repository to create a store your agent can read.
        </p>
      </div>
    );
  }

  const task = selected ? tasks.find((t) => t.id === selected) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold text-fg">Board</h1>

        <div className="flex items-center gap-x-0.5 rounded-md border border-line bg-panel p-0.5">
          {(["none", "phase", "feature"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setGrouping(mode)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                grouping === mode ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-subtle",
              )}
            >
              {mode === "none" ? "No grouping" : `By ${mode}`}
            </button>
          ))}
        </div>

        <TextInput
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tasks…"
          className="h-8 w-56 text-sm"
        />

        <span className="ml-auto text-xs text-fg-subtle">
          {visible.length} task{visible.length === 1 ? "" : "s"}
        </span>
      </div>

      {lanes.map((lane) => (
        <section key={lane.key}>
          {lane.label ? (
            <div className="mb-2 flex items-baseline gap-x-2">
              <h2 className="text-sm font-semibold text-fg">{lane.label}</h2>
              {lane.hint ? <span className="text-xs text-fg-subtle">{lane.hint}</span> : null}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {TASK_STATUSES.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={lane.tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order)}
                features={features}
                phases={phases}
                git={git}
                nodeLookup={nodeLookup}
                root={root}
                onMove={move}
                onCreate={(title) =>
                  create({
                    title,
                    status,
                    featureId: grouping === "feature" && lane.key !== "_" ? lane.key : undefined,
                    phaseId: grouping === "phase" && lane.key !== "_" ? lane.key : undefined,
                  })
                }
                onSelect={setSelected}
                onRemove={remove}
              />
            ))}
          </div>
        </section>
      ))}

      {task ? (
        <Detail
          task={task}
          features={roadmap.features}
          phases={roadmap.phases}
          commits={git[task.id] ?? []}
          root={root}
          onClose={() => setSelected(null)}
          onUpdate={update}
        />
      ) : null}
    </div>
  );
};

/** A task's phase, falling back to the phase of the feature it implements. */
const laneOfPhase = (task: Task, features: Record<string, Feature>): string | undefined =>
  task.phaseId ?? (task.featureId ? features[task.featureId]?.phaseId : undefined);

const Column = ({
  status,
  tasks,
  features,
  phases,
  git,
  nodeLookup,
  root,
  onMove,
  onCreate,
  onSelect,
  onRemove,
}: {
  status: TaskStatus;
  tasks: Task[];
  features: Record<string, Feature>;
  phases: Record<string, Phase>;
  git: Record<string, LinkedCommit[]>;
  nodeLookup: NodeLookup;
  root?: string;
  onMove: (id: string, status: TaskStatus, index?: number) => void;
  onCreate: (title: string) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) => {
  const [over, setOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const title = draft.trim();
    setComposing(false);
    setDraft("");
    if (title) onCreate(title);
  };

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
        setDropIndex(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        // The id travels in dataTransfer, not React state: a handler reading
        // state set during onDragStart in the same tick sees the old value.
        const id = e.dataTransfer.getData("text/plain");
        if (id) onMove(id, status, dropIndex ?? tasks.length);
        setOver(false);
        setDropIndex(null);
      }}
      className={cn(
        "rounded-lg border border-transparent p-1 transition-colors",
        over && "border-line-strong bg-bg-subtle/70",
      )}
    >
      <header className="mb-2 flex items-center gap-x-2 px-1">
        <span className={cn("h-2 w-2 rounded-full", COLUMN_ACCENT[status])} />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {COLUMN_LABELS[status]}
        </h3>
        <span className="text-xs text-fg-subtle">{tasks.length}</span>
        <button
          onClick={() => {
            setComposing(true);
            setDraft("");
          }}
          className="ml-auto text-fg-subtle hover:text-fg"
          aria-label={`Add to ${COLUMN_LABELS[status]}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </header>

      {composing ? (
        <TextInput
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setComposing(false);
              setDraft("");
            }
          }}
          placeholder="Task title…"
          className="mb-2 h-8 text-sm"
        />
      ) : null}

      <div className="space-y-2">
        {tasks.map((task, index) => (
          <div key={task.id}>
            {dropIndex === index ? <Insertion /> : null}
            <Card
              task={task}
              feature={task.featureId ? features[task.featureId] : undefined}
              phase={
                task.phaseId
                  ? phases[task.phaseId]
                  : task.featureId && features[task.featureId]?.phaseId
                    ? phases[features[task.featureId].phaseId!]
                    : undefined
              }
              commits={git[task.id] ?? []}
              nodeLookup={nodeLookup}
              root={root}
              onDragOverIndex={() => setDropIndex(index)}
              onSelect={() => onSelect(task.id)}
              onRemove={() => onRemove(task.id)}
            />
          </div>
        ))}
        {dropIndex === tasks.length ? <Insertion /> : null}
        <div
          className="h-6"
          onDragOver={(e) => {
            e.preventDefault();
            setDropIndex(tasks.length);
          }}
        />
      </div>
    </section>
  );
};

const Insertion = () => <div className="mb-2 h-0.5 rounded-full bg-status-todo" />;

const Card = ({
  task,
  feature,
  phase,
  commits,
  nodeLookup,
  root,
  onDragOverIndex,
  onSelect,
  onRemove,
}: {
  task: Task;
  feature?: Feature;
  phase?: Phase;
  commits: LinkedCommit[];
  nodeLookup: NodeLookup;
  root?: string;
  onDragOverIndex: () => void;
  onSelect: () => void;
  onRemove: () => void;
}) => {
  const [dragging, setDragging] = useState(false);
  const insertions = commits.reduce((n, c) => n + c.insertions, 0);
  const deletions = commits.reduce((n, c) => n + c.deletions, 0);

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={onDragOverIndex}
      onClick={onSelect}
      className={cn(
        "group cursor-pointer rounded-md border border-line bg-panel p-2.5 shadow-sm transition-opacity hover:border-line-strong",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-x-2">
        <p className="flex-1 text-sm text-fg">{task.title}</p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-status-danger group-hover:opacity-100"
          aria-label="Delete task"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {feature || phase ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {feature ? (
            <span className="max-w-full truncate rounded bg-status-todo/10 px-1.5 py-0.5 text-[10px] font-medium text-status-todo">
              {feature.title}
            </span>
          ) : null}
          {phase ? (
            <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-fg-muted">
              {phase.name}
            </span>
          ) : null}
        </div>
      ) : null}

      {commits.length || task.branch ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-fg-subtle">
          {task.branch ? (
            <span className="flex items-center gap-x-1 font-mono">
              <GitBranch className="h-3 w-3" />
              {task.branch}
            </span>
          ) : null}
          {commits.length ? (
            <span className="flex items-center gap-x-1">
              <GitCommit className="h-3 w-3" />
              {commits.length}
              <span className="font-mono text-status-done">+{insertions}</span>
              <span className="font-mono text-status-danger">&minus;{deletions}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {task.nodeIds?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.nodeIds.map((nodeId) => {
            const node = nodeLookup[nodeId];
            if (!node) return null;
            return (
              <Link
                key={nodeId}
                onClick={(e) => e.stopPropagation()}
                href={
                  root
                    ? `/project/diagram/${node.diagramId}?root=${encodeURIComponent(root)}`
                    : `/project/diagram/${node.diagramId}`
                }
                className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-line"
              >
                {node.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </article>
  );
};

/**
 * The task detail panel.
 *
 * Before this the board could create a task and delete it, and nothing in
 * between -- not even fixing a typo in the title.
 */
const Detail = ({
  task,
  features,
  phases,
  commits,
  root,
  onClose,
  onUpdate,
}: {
  task: Task;
  features: Feature[];
  phases: Phase[];
  commits: LinkedCommit[];
  root?: string;
  onClose: () => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
}) => {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [branching, setBranching] = useState<string | null>(null);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
  }, [task.id, task.title, task.description]);

  const startBranch = async (worktree: boolean) => {
    const name = `feat/${task.id}-…`;
    // Writing to someone's repository is confirmed every time, even though the
    // write is additive and never touches the checkout.
    const confirmed = window.confirm(
      worktree
        ? `Create branch ${name} and a worktree beside this repository?\n\nThe branch is not checked out and nothing is committed.`
        : `Create branch ${name}?\n\nIt will not be checked out, and nothing is committed.`,
    );
    if (!confirmed) return;

    const query = root ? `?root=${encodeURIComponent(root)}` : "";
    setBranching("working");
    try {
      const response = await fetch(`/api/project/git/branch${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, worktree }),
      });
      const data = await response.json();
      setBranching(response.ok ? `Created ${data.branch.branch}` : data.error);
    } catch {
      setBranching("Could not create the branch.");
    }
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[380px] flex-col border-l border-line bg-panel shadow-xl">
      <header className="flex items-center gap-x-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-sm font-semibold text-fg">Task</h2>
        <span className="font-mono text-xs text-fg-subtle">{task.id}</span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <Field label="Title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && onUpdate(task.id, { title: title.trim() })}
            className="h-8 text-sm"
          />
        </Field>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== (task.description ?? "") && onUpdate(task.id, { description })}
            rows={3}
            className="w-full rounded-md border border-line px-2 py-1.5 text-sm outline-none focus:border-line-strong"
          />
        </Field>

        <Field label="Feature">
          <select
            value={task.featureId ?? ""}
            onChange={(e) => onUpdate(task.id, { featureId: e.target.value || undefined })}
            className="w-full rounded-md border border-line px-2 py-1.5 text-sm outline-none focus:border-line-strong"
          >
            <option value="">None</option>
            {features.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Phase">
          <select
            value={task.phaseId ?? ""}
            onChange={(e) => onUpdate(task.id, { phaseId: e.target.value || undefined })}
            className="w-full rounded-md border border-line px-2 py-1.5 text-sm outline-none focus:border-line-strong"
          >
            <option value="">Inherit from the feature</option>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Git">
          {task.branch ? (
            <p className="font-mono text-xs text-fg-muted">{task.branch}</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs text-fg-muted">
                Opens <code className="font-mono">feat/{task.id}-…</code> without checking it out.
                Every commit on it links back here automatically.
              </p>
              <div className="flex gap-x-2">
                <button
                  onClick={() => void startBranch(false)}
                  className="rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-bg-subtle"
                >
                  Create branch
                </button>
                <button
                  onClick={() => void startBranch(true)}
                  className="rounded-md border border-line px-2 py-1 text-xs font-medium hover:bg-bg-subtle"
                >
                  + worktree
                </button>
              </div>
            </div>
          )}
          {branching ? <p className="mt-1 text-xs text-fg-muted">{branching}</p> : null}
        </Field>

        {commits.length ? (
          <Field label={`Commits (${commits.length})`}>
            <ul className="space-y-1">
              {commits.map((commit) => (
                <li key={commit.sha} className="flex items-baseline gap-x-2 text-xs">
                  <span className="font-mono text-fg-subtle">{commit.short}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{commit.subject}</span>
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
      </div>
    </aside>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
    {children}
  </div>
);
