"use client";

import { AlertTriangle, Check, GitCommit } from "lucide-react";
import { useMemo } from "react";

import type { LinkedCommit } from "@/lib/project/git-link";
import type { Feature, Phase, Task } from "@/lib/project/types";
import { cn } from "@/lib/utils";

/**
 * Delivery: what the PRD claims, next to what the repository shows.
 *
 * Every general-purpose tool in this space measures ACTIVITY. GitHub's Pulse
 * ranks the top fifteen committers to the default branch over seven days; its
 * network graph plots a hundred branches by owner. Both answer "how busy were
 * we". Neither can answer "is this feature actually built", because neither
 * knows what a feature is.
 *
 * This does, because a commit here resolves to a task and a task to a PRD
 * feature. So the interesting output is not a count -- it is the two places
 * where the claim and the evidence DISAGREE:
 *
 *   - a feature marked done with no commit behind it
 *   - sustained commit activity against a feature nobody has started
 *
 * Neither is necessarily wrong. A docs-only feature legitimately has no code,
 * and exploratory work legitimately precedes the board. But both are worth a
 * human glance, and nothing else on the page will surface them.
 */

type Row = {
  feature: Feature;
  phase?: Phase;
  commits: LinkedCommit[];
  insertions: number;
  deletions: number;
  lastAt?: string;
  done: number;
  total: number;
  /** Claimed complete, but no commit is attributed to it. */
  unevidenced: boolean;
  /** Real commit activity against something the board has not started. */
  unplanned: boolean;
};

export const Delivery = ({
  features,
  phases,
  tasks,
  commits,
}: {
  features: Feature[];
  phases: Phase[];
  tasks: Task[];
  commits: LinkedCommit[];
}) => {
  const rows = useMemo((): Row[] => {
    const phaseById = new Map(phases.map((p) => [p.id, p]));
    // A commit attributed to a task counts toward that task's feature.
    const featureOfTask = new Map(tasks.map((t) => [t.id, t.featureId]));

    /**
     * A commit contributes to a feature two ways, and both count.
     *
     * Its primary attribution says what it was FOR. Its `touched` list says
     * which features' declared paths it actually landed code in. A single large
     * commit is legitimately both -- recorded against one task while building
     * several features -- so crediting only the former would show one feature
     * with the entire diff and the rest with nothing.
     */
    const byFeature = new Map<string, { commit: LinkedCommit; insertions: number; deletions: number }[]>();
    const add = (
      featureId: string,
      commit: LinkedCommit,
      insertions: number,
      deletions: number,
    ) => {
      const list = byFeature.get(featureId) ?? [];
      if (list.some((e) => e.commit.sha === commit.sha)) return;
      byFeature.set(featureId, [...list, { commit, insertions, deletions }]);
    };

    for (const commit of commits) {
      for (const t of commit.touched ?? []) {
        // Churn measured inside that feature's own paths, not the whole diff.
        add(t.featureId, commit, t.insertions, t.deletions);
      }
      const claimed =
        commit.featureId ?? (commit.taskId ? featureOfTask.get(commit.taskId) : undefined);
      // A feature with no declared paths can still be credited by its task.
      if (claimed && !(commit.touched ?? []).some((t) => t.featureId === claimed)) {
        add(claimed, commit, commit.insertions, commit.deletions);
      }
    }

    return features.map((feature) => {
      const own = byFeature.get(feature.id) ?? [];
      const done = feature.acceptance.filter((c) => c.done).length;
      const total = feature.acceptance.length;

      return {
        feature,
        phase: feature.phaseId ? phaseById.get(feature.phaseId) : undefined,
        commits: own.map((e) => e.commit),
        insertions: own.reduce((n, e) => n + e.insertions, 0),
        deletions: own.reduce((n, e) => n + e.deletions, 0),
        lastAt: own.map((e) => e.commit.at).sort().pop(),
        done,
        total,
        unevidenced: feature.status === "done" && own.length === 0,
        unplanned: own.length >= 2 && feature.status === "todo",
      };
    });
  }, [features, phases, tasks, commits]);

  const flagged = rows.filter((r) => r.unevidenced || r.unplanned);
  const evidenced = rows.filter((r) => r.commits.length > 0).length;
  const maxChurn = Math.max(1, ...rows.map((r) => r.insertions + r.deletions));

  if (!features.length) {
    return null;
  }

  return (
    <section className="rounded-xl bg-panel shadow-xs ring-1 ring-inset ring-line/60">
      <div className="px-4 pb-2 pt-3.5">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
          Delivery
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          What the PRD claims, beside what the repository shows.{" "}
          <span className="text-fg">
            {evidenced} of {rows.length} features have commit evidence.
          </span>
        </p>
      </div>

      {flagged.length ? (
        <ul className="border-b border-line bg-status-progress/5">
          {flagged.map((row) => (
            <li
              key={row.feature.id}
              className="flex items-start gap-x-2 px-4 py-2 text-xs text-status-progress">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-progress" />
              <span>
                <span className="font-medium">{row.feature.title}</span>{" "}
                {row.unevidenced
                  ? "is marked done but no commit is attributed to it. Either the work landed without a link, or it did not land.": `has ${row.commits.length} commits but is still on the to-do column. Work may have started without the board catching up.`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="divide-y divide-line">
        {rows.map((row) => {
          const churn = row.insertions + row.deletions;
          return (
            <li key={row.feature.id} className="flex items-center gap-x-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-x-2">
                  <span className="truncate text-sm text-fg">
                    {row.feature.title}
                  </span>
                  {row.phase ? (
                    <span className="shrink-0 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-fg-muted">
                      {row.phase.name}
                    </span>
                  ) : null}
                </span>

                {/* Claim: acceptance criteria ticked in the PRD. */}
                <span className="mt-1 flex items-center gap-x-2">
                  <span className="h-1 w-28 overflow-hidden rounded-full bg-bg-subtle">
                    <span
                      className={cn(
                        "block h-full",
                        row.done === row.total && row.total > 0
                          ? "bg-status-done": "bg-status-progress",
                      )}
                      style={{ width: `${row.total ? (row.done / row.total) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="text-[11px] tabular-nums text-fg-subtle">
                    {row.done}/{row.total} criteria
                  </span>
                </span>
              </span>

              {/* Evidence: churn actually attributed to it. */}
              <span className="flex w-40 shrink-0 items-center justify-end gap-x-2">
                {churn ? (
                  <>
                    <span className="font-mono text-[11px] text-fg-subtle">
                      <span className="text-status-done">+{row.insertions}</span>{" "}
                      <span className="text-status-danger">&minus;{row.deletions}</span>
                    </span>
                    <span
                      className="h-1.5 rounded-full bg-status-todo"style={{ width: `${Math.max(4, (churn / maxChurn) * 64)}px` }}
                      title={`${churn} lines changed across ${row.commits.length} commits`}
                    />
                  </>
                ) : (
                  <span className="text-[11px] text-fg-subtle">no commits</span>
                )}
              </span>

              <span className="flex w-16 shrink-0 items-center justify-end gap-x-1 text-xs text-fg-muted">
                {row.commits.length ? (
                  <>
                    <GitCommit className="h-3 w-3" />
                    {row.commits.length}
                  </>
                ) : row.feature.status === "done" ? (
                  <Check className="h-3.5 w-3.5 text-status-done" />
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
