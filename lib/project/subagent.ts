/**
 * Runs for subagents (devolps TR-03).
 *
 * A Claude Code session that starts a subagent produces three hook events: a
 * PreToolUse for the spawn (whose prompt names the task), a SubagentStart (which
 * names the agent but not the spawn), and a SubagentStop. The start carries no
 * id that links it to its spawn, so the Nth start of a role in a session is
 * matched to the Nth spawn request of that role -- the same rule the devolps
 * agent ledger uses.
 *
 * The child run records its role, its parent run and the harness's agent id, so
 * the subagent's own tool calls count against it, not against the main session.
 */

import { appendEvent, readEvents } from "./events";
import type { AgentRun } from "./run";
import { readRuns, runForSession, setRunState, startRun } from "./store";

export const recordSpawnRequest = (root: string, e: { sessionId: string; agentType: string; taskId?: string }): void => {
  appendEvent(root, { kind: "run.requested", data: { sessionId: e.sessionId, agentType: e.agentType, taskId: e.taskId } });
};

export const startSubagentRun = (root: string, e: { sessionId: string; agentId: string; agentType: string }): AgentRun => {
  const parent = runForSession(root, e.sessionId);
  const requests = readEvents(root).filter(
    (ev) => ev.kind === "run.requested" && ev.data.sessionId === e.sessionId && ev.data.agentType === e.agentType,
  );
  const alreadyStarted = readRuns(root).filter(
    (r) => r.sessionId === e.sessionId && r.parentRunId !== undefined && r.role === e.agentType,
  ).length;
  const request = requests[alreadyStarted];
  return startRun(root, {
    sessionId: e.sessionId,
    taskId: typeof request?.data.taskId === "string" ? request.data.taskId : undefined,
    role: e.agentType,
    parentRunId: parent?.id,
    agentId: e.agentId,
    actor: { kind: "agent", harness: "claude-code" },
  });
};

export const runForAgent = (root: string, agentId: string): AgentRun | null =>
  readRuns(root).find((r) => r.agentId === agentId && r.state !== "merged" && r.state !== "abandoned") ?? null;

export const stopSubagentRun = (root: string, agentId: string): AgentRun | null => {
  const run = runForAgent(root, agentId);
  if (!run || run.state !== "running") return run;
  return setRunState(root, run.id, "awaiting_review", "the subagent finished");
};
