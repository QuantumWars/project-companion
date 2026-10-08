"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Clock, Copy, Loader2, Octagon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge, EmptyState, PageHeader, Panel, SectionHeader } from "@/components/ui/primitives";
import type { CockpitModel, DecisionItem } from "@/lib/project/cockpit";

import { BurnupChart } from "./burnup-chart";

/**
 * The PM cockpit (devolps PC-01..PC-11).
 *
 * Written for a project manager who does not read code: each section answers
 * one question, in plain words, with the bottom line first. Technical detail --
 * file paths, ids, commands for the other options -- sits behind "Details".
 *
 * Read-only by design (devolps decision Q4): every decision card shows the exact
 * command to type in Claude Code, with a copy button.
 */

const HEALTH = {
  "on-track": { label: "On track", tone: "success" as const, icon: CheckCircle2, meaning: "The target date and scope are likely to hold." },
  "at-risk": { label: "At risk", tone: "warning" as const, icon: AlertTriangle, meaning: "It can still hold, but something needs action." },
  "off-track": { label: "Off track", tone: "danger" as const, icon: Octagon, meaning: "It will not hold without a change of plan." },
};

const SECTIONS = [
  ["needs-you", "Needs you"],
  ["health", "Health"],
  ["progress", "Progress"],
  ["blocked", "Blocked"],
  ["shipped", "Shipped"],
  ["update", "Weekly update"],
  ["agents", "Agents"],
] as const;

const CopyCommand = ({ command }: { command: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mt-3 flex items-center gap-x-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-bg-subtle px-2.5 py-1.5 font-mono text-xs text-fg" title={command}>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-7 shrink-0 items-center gap-x-1.5 rounded-md bg-brand px-2.5 text-xs font-medium text-brand-fg hover:bg-brand-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        aria-label={`Copy the command ${command}`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
};

const DecisionCard = ({ item }: { item: DecisionItem }) => (
  <Panel className={cn("p-4", item.overdue && "ring-status-progress/60")}>
    <div className="flex items-start justify-between gap-x-3">
      <h3 className="text-sm font-semibold leading-snug text-fg">{item.title}</h3>
      {item.overdue ? (
        <Badge tone="warning">
          <Clock className="h-3 w-3" /> waiting {item.waitingDays} working days
        </Badge>
      ) : (
        <Badge>{item.waitingDays === 0 ? "new today" : `waiting ${item.waitingDays} day${item.waitingDays === 1 ? "" : "s"}`}</Badge>
      )}
    </div>
    <p className="mt-1.5 text-sm text-fg-muted">{item.why}</p>
    {item.options.length > 0 && item.kind !== "gate" ? (
      <p className="mt-2 text-sm text-fg">
        Options: {item.options.join(" · ")}
        {item.recommendation ? <span className="text-fg-muted"> — recommended: <strong className="text-fg">{item.recommendation}</strong></span> : null}
      </p>
    ) : null}
    <p className="mt-1 text-xs text-fg-muted">
      If you wait: {item.costOfWaiting}
      {item.deadline ? ` Decide by ${item.deadline}.` : ""}
    </p>
    <CopyCommand command={item.command} />
    {Object.keys(item.details).length ? (
      <details className="mt-2 text-xs text-fg-muted">
        <summary className="cursor-pointer select-none">Details</summary>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {Object.entries(item.details).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-subtle">{k}</dt>
              <dd className="break-all font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    ) : null}
  </Panel>
);

export const Cockpit = ({ root }: { root?: string }) => {
  const [model, setModel] = useState<CockpitModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/project/cockpit${query}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `The cockpit could not load (${response.status}).`);
      setModel(body as CockpitModel);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [query]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !model) return <EmptyState title="The cockpit could not load">{error}</EmptyState>;
  if (!model) {
    return (
      <div className="flex items-center gap-x-2 p-8 text-sm text-fg-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the cockpit…
      </div>
    );
  }

  const decisions = model.needsYou.length;
  const worst = model.epics.reduce<keyof typeof HEALTH>(
    (w, e) => (["on-track", "at-risk", "off-track"].indexOf(e.health.value) > ["on-track", "at-risk", "off-track"].indexOf(w) ? e.health.value : w),
    "on-track",
  );
  const bottomLine =
    decisions === 0
      ? `Nothing needs your decision right now.`
      : `${decisions} decision${decisions === 1 ? "" : "s"} need${decisions === 1 ? "s" : ""} you${model.needsYou.some((d) => d.overdue) ? ", and some are overdue" : ""}.`;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHeader
        title="Cockpit"
        description={
          <>
            {bottomLine}{" "}
            {model.epics.length ? `Overall: ${HEALTH[worst].label.toLowerCase()}.` : ""} You decide in Claude Code; this page only shows.
          </>
        }
      />

      <nav aria-label="Cockpit sections" className="sticky top-0 z-10 -mx-2 mb-6 flex flex-wrap gap-1 bg-bg/90 px-2 py-2 backdrop-blur">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-subtle hover:text-fg">
            {label}
            {id === "needs-you" && decisions ? <span className="ml-1 font-semibold text-fg">{decisions}</span> : null}
            {id === "blocked" && model.blocked.length ? <span className="ml-1 font-semibold text-fg">{model.blocked.length}</span> : null}
          </a>
        ))}
      </nav>

      <div className="space-y-10">
        <section id="needs-you" className="scroll-mt-14">
          <SectionHeader title="Needs you now" hint="Each card is one decision. Copy its command and paste it into Claude Code." />
          {decisions ? (
            <div className="grid gap-3">{model.needsYou.map((item) => <DecisionCard key={item.id} item={item} />)}</div>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">Nothing is waiting for you. Agents will add a card here when they need a decision.</Panel>
          )}
        </section>

        <section id="health" className="scroll-mt-14">
          <SectionHeader title="Health" hint="On track, at risk or off track, with the reason. A decision waiting more than 2 working days makes an epic at risk." />
          {model.epics.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {model.epics.map((e) => {
                const h = HEALTH[e.health.value];
                return (
                  <Panel key={e.id} className="p-4">
                    <div className="flex items-start justify-between gap-x-3">
                      <h3 className="text-sm font-semibold text-fg">{e.name}</h3>
                      <Badge tone={h.tone} title={h.meaning}>
                        <h.icon className="h-3 w-3" /> {h.label}
                      </Badge>
                    </div>
                    <p className="mt-1.5 text-sm text-fg">{e.health.reason}</p>
                    <p className="mt-2 text-xs text-fg-muted">
                      Stage: <span className="text-fg">{e.stage}</span>
                      {e.target ? ` · Target: ${e.target}` : ""}
                      {e.features.total ? ` · ${e.features.done} of ${e.features.total} features done` : ""}
                    </p>
                  </Panel>
                );
              })}
            </div>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">No epics yet. Start one in Claude Code with /devolps:idea.</Panel>
          )}
        </section>

        <section id="progress" className="scroll-mt-14">
          <SectionHeader title="Progress vs plan" hint="The line rises when work is finished. Work added after the sprint started is counted, and shown, as added." />
          {model.sprint ? (
            <Panel className="p-4">
              <p className="text-sm text-fg">
                <strong>{model.sprint.name}</strong>
                {model.sprint.goal ? ` — ${model.sprint.goal}` : ""}
              </p>
              <p className="mb-3 mt-0.5 text-xs text-fg-muted">
                {model.sprint.start} to {model.sprint.end} · {model.sprint.burnup.done} of {model.sprint.burnup.committed + model.sprint.burnup.added} {model.sprint.burnup.unit} done
                {model.sprint.burnup.added ? ` (${model.sprint.burnup.added} added after the start)` : ""}
              </p>
              {model.sprint.goalAtRisk ? (
                <p className="mb-3 flex items-center gap-x-1.5 text-sm text-status-progress">
                  <AlertTriangle className="h-4 w-4" /> The sprint goal is at risk: {model.sprint.goalRisk}
                </p>
              ) : null}
              <BurnupChart data={model.sprint.burnup} />
            </Panel>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">No sprint is running. The next one starts after you approve it.</Panel>
          )}
          {model.epics.length ? (
            <div className="mt-3 grid gap-2">
              {model.epics.map((e) => (
                <p key={e.id} className="text-sm text-fg-muted">
                  <span className="text-fg">{e.name}</span>:{" "}
                  {e.forecast
                    ? `likely done between ${e.forecast.finish.earliest} and ${e.forecast.finish.latest} (${e.forecast.remaining} left).`
                    : "not enough history for a forecast yet (it needs 3 finished sprints)."}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section id="blocked" className="scroll-mt-14">
          <SectionHeader title="Blocked and why" hint="What is stuck, why, and who can unstick it." />
          {model.blocked.length ? (
            <Panel className="divide-y divide-line/60">
              {model.blocked.map((b) => (
                <div key={b.taskId} className="p-4">
                  <p className="text-sm font-medium text-fg">{b.title}</p>
                  <p className="mt-0.5 text-sm text-fg-muted">
                    {b.reason} — {b.cause}. Who can unblock it: <span className="text-fg">{b.unblocker}</span>.{" "}
                    {b.daysBlocked === 0 ? "Blocked since today" : `Blocked for ${b.daysBlocked} working day${b.daysBlocked === 1 ? "" : "s"}`}
                    {b.sprint ? `, in sprint ${b.sprint}` : ""}.
                  </p>
                </div>
              ))}
            </Panel>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">Nothing is blocked.</Panel>
          )}
        </section>

        <section id="shipped" className="scroll-mt-14">
          <SectionHeader title="Shipped this week" hint="Work finished in the last 7 days." />
          {model.shipped.length ? (
            <Panel className="divide-y divide-line/60">
              {model.shipped.map((s) => (
                <div key={s.taskId} className="flex items-center justify-between gap-x-3 p-3">
                  <p className="text-sm text-fg">{s.title}</p>
                  <p className="shrink-0 text-xs text-fg-muted">
                    {s.doneAt}
                    {s.pr?.url ? (
                      <>
                        {" · "}
                        <a href={s.pr.url} className="underline decoration-line underline-offset-2 hover:text-fg" target="_blank" rel="noreferrer">
                          details
                        </a>
                      </>
                    ) : null}
                  </p>
                </div>
              ))}
            </Panel>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">Nothing finished in the last 7 days.</Panel>
          )}
        </section>

        <section id="update" className="scroll-mt-14">
          <SectionHeader title="Weekly update" hint="Drafted by the Engineering Manager each Friday. You publish it with /devolps:publish-update." />
          {model.update.late ? (
            <p className="mb-2 flex items-center gap-x-1.5 text-sm text-status-progress">
              <Clock className="h-4 w-4" /> Update late: {model.update.lateReason}
            </p>
          ) : null}
          {model.update.latest ? (
            <Panel className="p-4">
              <div className="flex items-center justify-between gap-x-3">
                <h3 className="text-sm font-semibold text-fg">Week {model.update.latest.id}</h3>
                <Badge tone={model.update.latest.publishedAt ? "success" : "neutral"}>{model.update.latest.publishedAt ? "published" : "draft"}</Badge>
              </div>
              <p className="mt-1.5 text-sm text-fg">
                {HEALTH[model.update.latest.health].label}: {model.update.latest.reason}
              </p>
              {model.update.latest.body ? (
                <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-fg-muted">{model.update.latest.body}</pre>
              ) : null}
              {!model.update.latest.publishedAt ? <CopyCommand command={`/devolps:publish-update ${model.update.latest.id}`} /> : null}
            </Panel>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">No update yet. Ask for one in Claude Code with /devolps:status-update.</Panel>
          )}
        </section>

        <section id="agents" className="scroll-mt-14">
          <SectionHeader title="Agent team" hint="What each agent is doing right now. At most 2 work at the same time." />
          {model.agents.length ? (
            <Panel className="divide-y divide-line/60">
              {model.agents.map((a, i) => (
                <div key={`${a.role}-${i}`} className="flex items-center justify-between gap-x-3 p-3">
                  <p className="text-sm text-fg">
                    <span className="font-medium">{a.role}</span>
                    <span className="text-fg-muted"> — {a.doing}</span>
                  </p>
                  <p className="shrink-0 text-xs text-fg-muted">
                    {a.state} · {a.minutes} min
                  </p>
                </div>
              ))}
            </Panel>
          ) : (
            <Panel className="p-4 text-sm text-fg-muted">No agent is working right now.</Panel>
          )}
        </section>
      </div>

      <p className="mt-10 text-xs text-fg-subtle">
        Updated {new Date(model.generatedAt).toLocaleTimeString()}. This page refreshes every few seconds.
      </p>
    </div>
  );
};
