"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Bot, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Badge, Button, EmptyState, PageHeader, Panel, Progress, Row, SectionHeader, Segmented,
} from "@/components/ui/primitives";
import type { AgentRun, BudgetVerdict, RunState } from "@/lib/project/run";

type Run = AgentRun & { budgetVerdict: BudgetVerdict };
type Scope = "flight" | "all";

/** The states a person can move a run into, and what each button says. */
const ACTIONS: Partial<Record<RunState, { to: RunState; label: string; primary?: boolean }[]>> = {
  proposed: [{ to: "approved", label: "Approve", primary: true }, { to: "abandoned", label: "Decline" }],
  approved: [{ to: "running", label: "Start", primary: true }, { to: "abandoned", label: "Cancel" }],
  running: [{ to: "awaiting_review", label: "Send to review" }, { to: "abandoned", label: "Stop" }],
  blocked: [{ to: "running", label: "Resume", primary: true }, { to: "abandoned", label: "Stop" }],
  awaiting_review: [{ to: "merged", label: "Merge", primary: true }, { to: "running", label: "Send back" }],
};

const TONE: Record<RunState, "neutral" | "brand" | "success" | "warning" | "danger"> = {
  proposed: "neutral",
  approved: "brand",
  running: "brand",
  blocked: "warning",
  awaiting_review: "warning",
  merged: "success",
  abandoned: "neutral",
};

export const MissionControl = ({ root }: { root?: string }) => {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [scope, setScope] = useState<Scope>("flight");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  const load = useCallback(async () => {
    const response = await fetch(`/api/project/runs${query}`);
    const body = (await response.json()) as { runs?: Run[] };
    setRuns(body.runs ?? []);
  }, [query]);

  // A run moves while you are looking at it, so this polls. Four seconds
  // matches every other surface here; the event log makes a cheaper stream
  // possible later, and this is not the phase to build it.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const move = async (id: string, state: RunState) => {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/project/runs/${id}${query}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Could not move the run (${response.status})`);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!runs) {
    return <div className="px-6 py-7 text-[13px] text-fg-muted">Reading the log…</div>;
  }

  const inFlight = runs.filter((r) => r.state !== "merged" && r.state !== "abandoned");
  const shown = scope === "flight" ? inFlight : runs;
  const attention = inFlight.filter((r) => r.state === "blocked" || r.state === "awaiting_review");

  return (
    <div className="px-6 py-7">
      <PageHeader
        title="Agents"
        description="What is running, what it is spending, and what is waiting on you."
        actions={
          <Segmented
            options={[
              { value: "flight", label: `In flight ${inFlight.length}` },
              { value: "all", label: `All ${runs.length}` },
            ]}
            value={scope}
            onChange={setScope}
          />
        }
      />

      {error ? (
        <Panel className="mb-5 flex items-center gap-x-2 p-3 text-[13px] text-status-danger">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </Panel>
      ) : null}

      {/* Escalation, first. A blocked run is not making progress and nobody is
          being told; putting it below a list of healthy ones buries the only
          thing on this page that needs a person. */}
      {attention.length ? (
        <section className="mb-7">
          <SectionHeader title="Waiting on you" hint={`${attention.length}`} />
          <Panel className="divide-y divide-line/60">
            {attention.map((run) => (
              <RunRow key={run.id} run={run} busy={busy === run.id} query={query} onMove={move} />
            ))}
          </Panel>
        </section>
      ) : null}

      <SectionHeader title={scope === "flight" ? "In flight" : "Every run"} />
      {shown.length ? (
        <Panel className="divide-y divide-line/60">
          {shown
            .filter((r) => !attention.includes(r))
            .map((run) => (
              <RunRow key={run.id} run={run} busy={busy === run.id} query={query} onMove={move} />
            ))}
        </Panel>
      ) : (
        <EmptyState icon={<Bot className="h-5 w-5" />} title="Nothing running">
          A run opens when an agent picks up work, or with{" "}
          <code>project-companion run start &lt;taskId&gt;</code>.
        </EmptyState>
      )}
    </div>
  );
};

const RunRow = ({
  run,
  busy,
  query,
  onMove,
}: {
  run: Run;
  busy: boolean;
  query: string;
  onMove: (id: string, state: RunState) => void;
}) => {
  const tokens = run.spent.inputTokens + run.spent.outputTokens;
  const ceiling = run.budget.tokens;

  return (
    <Row interactive={false} className="flex-wrap gap-y-2">
      <Badge tone={TONE[run.state]}>{run.state.replace("_", " ")}</Badge>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-fg">
          {run.actor.model ?? "unknown model"}
          {run.componentId ? (
            <Link href={`/project/node/${run.componentId}${query}`} className="ml-2 text-fg-muted hover:text-fg">
              {run.componentId}
            </Link>
          ) : (
            <span className="ml-2 text-fg-subtle">unscoped</span>
          )}
        </p>
        <p className="truncate text-2xs text-fg-subtle">
          {run.touched.length} file{run.touched.length === 1 ? "" : "s"} ·{" "}
          {run.spent.toolCalls} tool calls
          {run.reason ? ` · ${run.reason}` : ""}
        </p>
      </div>

      {/* Spend against the ceiling, or just spend when nobody set one. A bar
          with no ceiling would be a bar with no meaning. */}
      <div className="w-32 shrink-0">
        <p
          className={cn(
            "mb-1 text-right text-2xs tabular-nums",
            run.budgetVerdict.ok ? "text-fg-subtle" : "text-status-progress",
          )}
        >
          {tokens.toLocaleString()}
          {ceiling ? ` / ${ceiling.toLocaleString()}` : ""} tok
        </p>
        {ceiling ? <Progress value={Math.min(tokens, ceiling)} total={ceiling} /> : null}
      </div>

      <div className="flex shrink-0 items-center gap-x-1.5">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-subtle" /> : null}
        {(ACTIONS[run.state] ?? []).map((action) => (
          <Button
            key={action.to}
            size="sm"
            variant={action.primary ? "primary" : "ghost"}
            disabled={busy}
            onClick={() => onMove(run.id, action.to)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </Row>
  );
};
