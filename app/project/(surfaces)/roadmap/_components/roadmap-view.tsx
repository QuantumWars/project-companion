"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileWarning,
  GitCommit,
  Plus,
  Square,
  Tag,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { useRoadmap } from "@/lib/project/use-roadmap";
import type { Feature, Task, TaskStatus } from "@/lib/project/types";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<TaskStatus, string> = {
  backlog: "bg-neutral-100 text-neutral-600",
  todo: "bg-sky-50 text-sky-700",
  in_progress: "bg-amber-50 text-amber-700",
  review: "bg-violet-50 text-violet-700",
  done: "bg-emerald-50 text-emerald-700",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

type GitActivity = Record<string, { commits: number; insertions: number; deletions: number }>;

export const RoadmapView = ({ root }: { root?: string }) => {
  const roadmap = useRoadmap(root);
  const [git, setGit] = useState<GitActivity>({});
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  useEffect(() => {
    fetch(`/api/project/git${query}`)
      .then((r) => r.json())
      .then((view) => {
        if (!view.available || !view.attribution) return;
        const byFeature = view.attribution.byFeature as Record<
          string,
          { insertions: number; deletions: number }[]
        >;
        setGit(
          Object.fromEntries(
            Object.entries(byFeature).map(([id, commits]) => [
              id,
              {
                commits: commits.length,
                insertions: commits.reduce((n, c) => n + c.insertions, 0),
                deletions: commits.reduce((n, c) => n + c.deletions, 0),
              },
            ]),
          ),
        );
      })
      .catch(() => {});
  }, [query]);

  const unphased = useMemo(
    () => roadmap.features.filter((f) => !f.phaseId),
    [roadmap.features],
  );

  if (roadmap.loading) {
    return <p className="text-sm text-neutral-400">Loading the roadmap…</p>;
  }

  if (!roadmap.present) {
    return <NoPrd source={roadmap.source} />;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-x-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">
            {roadmap.title ?? "Roadmap"}
          </h1>
          <p className="mt-1 font-mono text-xs text-neutral-400">{roadmap.source}</p>
        </div>
        <Progress features={roadmap.features} />
      </div>

      {roadmap.conflict ? (
        <div className="flex items-start gap-x-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{roadmap.conflict.message}</p>
            <p className="mt-0.5 text-xs">
              Your copy has been refreshed from disk. Re-apply the change if you still want it.
            </p>
          </div>
          <button
            onClick={roadmap.dismissConflict}
            className="text-xs font-medium underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {roadmap.warnings.map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-x-2 rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-600"
        >
          <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="flex-1">{warning}</span>
          {warning.includes("heading slug") ? (
            <button
              onClick={() => void roadmap.apply([{ op: "stampIds" }])}
              className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 font-medium hover:bg-neutral-50"
              title="Write a stable id comment under each heading so renames keep their links"
            >
              Stamp ids
            </button>
          ) : null}
        </div>
      ))}

      {roadmap.phases.map((phase) => (
        <section key={phase.id}>
          <div className="mb-3 flex items-baseline gap-x-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-800">
              {phase.name}
            </h2>
            <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", STATUS_STYLE[phase.status === "active" ? "in_progress" : phase.status === "done" ? "done" : "backlog"])}>
              {phase.status}
            </span>
            {phase.startsAt ? (
              <span className="text-xs text-neutral-400">
                {phase.startsAt}
                {phase.endsAt ? ` → ${phase.endsAt}` : ""}
              </span>
            ) : null}
            {phase.goal ? <span className="text-xs text-neutral-500">{phase.goal}</span> : null}
          </div>
          <div className="space-y-2">
            {roadmap.features
              .filter((f) => f.phaseId === phase.id)
              .map((feature) => (
                <FeatureCard
                  key={feature.id}
                  feature={feature}
                  tasks={roadmap.tasksByFeature[feature.id] ?? []}
                  git={git[feature.id]}
                  root={root}
                  apply={roadmap.apply}
                />
              ))}
            <AddFeature phaseId={phase.id} apply={roadmap.apply} />
          </div>
        </section>
      ))}

      {unphased.length ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-800">
            Unphased
          </h2>
          <div className="space-y-2">
            {unphased.map((feature) => (
              <FeatureCard
                key={feature.id}
                feature={feature}
                tasks={roadmap.tasksByFeature[feature.id] ?? []}
                git={git[feature.id]}
                root={root}
                apply={roadmap.apply}
              />
            ))}
          </div>
        </section>
      ) : null}

      {roadmap.orphans.length ? (
        <section>
          <h2 className="mb-1 flex items-center gap-x-2 text-sm font-semibold uppercase tracking-wide text-neutral-800">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            Orphaned
          </h2>
          <p className="mb-3 text-xs text-neutral-500">
            These headings are gone from the PRD, but tasks still point at them. Nothing was
            deleted.
          </p>
          <div className="space-y-2">
            {roadmap.orphans.map((feature) => (
              <div
                key={feature.id}
                className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 text-sm"
              >
                <span className="font-medium text-neutral-800">{feature.title}</span>
                <span className="ml-2 font-mono text-xs text-neutral-400">{feature.id}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
};

const Progress = ({ features }: { features: Feature[] }) => {
  const done = features.filter((f) => f.status === "done").length;
  const active = features.filter((f) => f.status === "in_progress" || f.status === "review").length;
  const pct = features.length ? Math.round((done / features.length) * 100) : 0;

  return (
    <div className="w-56 shrink-0">
      <div className="mb-1 flex items-baseline justify-between text-xs text-neutral-500">
        <span>
          {done} of {features.length} done
        </span>
        <span className="font-medium text-neutral-800">{pct}%</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-neutral-200">
        <div className="bg-emerald-500" style={{ width: `${pct}%` }} />
        <div
          className="bg-amber-400"
          style={{ width: `${features.length ? (active / features.length) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
};

const FeatureCard = ({
  feature,
  tasks,
  git,
  root,
  apply,
}: {
  feature: Feature;
  tasks: Task[];
  git?: { commits: number; insertions: number; deletions: number };
  root?: string;
  apply: ReturnType<typeof useRoadmap>["apply"];
}) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(feature.title);
  const done = feature.acceptance.filter((c) => c.done).length;

  const commitTitle = async () => {
    const value = draft.trim();
    setEditing(false);
    if (!value || value === feature.title) return;
    await apply([{ op: "setTitle", featureId: feature.id, value }]);
  };

  return (
    <div className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center gap-x-3 p-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-neutral-400 hover:text-neutral-700"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitTitle();
              if (e.key === "Escape") {
                setDraft(feature.title);
                setEditing(false);
              }
            }}
            className="h-7 flex-1 text-sm"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(feature.title);
              setEditing(true);
            }}
            className="flex-1 text-left text-sm font-medium text-neutral-900 hover:text-neutral-600"
            title="Rename — the id stays put, so linked tasks survive"
          >
            {feature.title}
          </button>
        )}

        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_STYLE[feature.status])}>
          {STATUS_LABEL[feature.status]}
          {feature.statusOverride ? " · pinned" : ""}
        </span>

        {feature.acceptance.length ? (
          <span className="shrink-0 text-xs tabular-nums text-neutral-400">
            {done}/{feature.acceptance.length}
          </span>
        ) : null}

        {git?.commits ? (
          <span
            className="flex shrink-0 items-center gap-x-1 text-xs text-neutral-500"
            title={`+${git.insertions} −${git.deletions}`}
          >
            <GitCommit className="h-3 w-3" />
            {git.commits}
          </span>
        ) : null}

        {feature.idSource === "slug" ? (
          <span
            className="shrink-0 text-amber-500"
            title="This id comes from the heading text, so renaming it in the PRD would orphan linked tasks"
          >
            <Tag className="h-3 w-3" />
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="space-y-3 border-t border-neutral-100 px-3 pb-3 pt-3 text-sm">
          {feature.summary ? (
            <p className="text-neutral-600">{feature.summary}</p>
          ) : null}

          {feature.acceptance.length ? (
            <ul className="space-y-1">
              {feature.acceptance.map((criterion) => (
                <li key={criterion.id}>
                  <button
                    onClick={() =>
                      void apply([
                        {
                          op: "setCriterion",
                          featureId: feature.id,
                          criterionId: criterion.id,
                          done: !criterion.done,
                        },
                      ])
                    }
                    className="flex w-full items-start gap-x-2 rounded px-1 py-0.5 text-left hover:bg-neutral-50"
                  >
                    {criterion.done ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    )}
                    <span className={cn("text-sm", criterion.done && "text-neutral-400 line-through")}>
                      {criterion.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-neutral-400">No acceptance criteria yet.</p>
          )}

          <AddCriterion featureId={feature.id} apply={apply} />

          {feature.paths?.length ? (
            <p className="font-mono text-xs text-neutral-400">
              paths: {feature.paths.join(", ")}
            </p>
          ) : null}

          {tasks.length ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tasks.map((task) => (
                <Link
                  key={task.id}
                  href={root ? `/project/tasks?root=${encodeURIComponent(root)}` : "/project/tasks"}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs hover:underline",
                    STATUS_STYLE[task.status],
                  )}
                >
                  {task.title}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const AddCriterion = ({
  featureId,
  apply,
}: {
  featureId: string;
  apply: ReturnType<typeof useRoadmap>["apply"];
}) => {
  const [draft, setDraft] = useState("");

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await apply([{ op: "addCriterion", featureId, text }]);
  };

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") setDraft("");
      }}
      placeholder="Add an acceptance criterion…"
      className="h-7 text-sm"
    />
  );
};

const AddFeature = ({
  phaseId,
  apply,
}: {
  phaseId: string;
  apply: ReturnType<typeof useRoadmap>["apply"];
}) => {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!composing) {
    return (
      <button
        onClick={() => setComposing(true)}
        className="flex items-center gap-x-1.5 px-1 py-1 text-xs text-neutral-400 hover:text-neutral-700"
      >
        <Plus className="h-3 w-3" />
        Add a feature
      </button>
    );
  }

  const submit = async () => {
    const title = draft.trim();
    setComposing(false);
    setDraft("");
    if (title) await apply([{ op: "addFeature", title, phaseId }]);
  };

  return (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") {
          setComposing(false);
          setDraft("");
        }
      }}
      placeholder="Feature name…"
      className="h-8 text-sm"
    />
  );
};

const NoPrd = ({ source }: { source: string }) => (
  <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
    <h2 className="text-base font-semibold text-neutral-900">No PRD yet</h2>
    <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
      The feature list lives in{" "}
      <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs">{source}</code>, so it
      is reviewed in a pull request like any other change and your agent can read it with ordinary
      file tools.
    </p>
    <pre className="mx-auto mt-4 max-w-md overflow-x-auto rounded-md bg-neutral-900 p-3 text-left font-mono text-xs text-neutral-100">
{`npx archboard prd init`}
    </pre>
  </div>
);
