/**
 * Gates: transitions only a person can open.
 *
 * The board already had two hard-coded gates -- a full WIP column refuses a
 * start, and a failing `Verify:` unticks what it refuses. This generalises the
 * idea the redesign asked for: a gate is a named decision on a subject, held
 * in the event log, that either opens or refuses with the smallest thing that
 * would turn it into a yes.
 *
 * ---- what is stored ----
 *
 * Nothing but events. `gate.requested`, `gate.approved`, `gate.refused` and
 * `track.confirmed` are appended to the actor's shard like every other fact,
 * and the current state of every gate is a fold over them. So an approval
 * cannot be edited quietly: it is a line in a hash-chained log, and changing it
 * breaks the chain `verifyLog` walks.
 *
 * ---- what an approval is bound to ----
 *
 * The bytes the person approved. Each approval records the sha256 of every
 * artifact the request named, and a gate whose artifacts have changed since is
 * STALE -- an approved design that was then rewritten is not an approved
 * design. Two artifacts are special:
 *
 *   prd-section:<epic>  the epic's section of the PRD, with checkbox marks
 *                       removed. The file holds every epic and `verify` ticks
 *                       boxes in it; hashing the whole file would stale every
 *                       approval on every verify run and every new epic.
 *   head:<sha>          a pull request's head commit, for the merge gate. The
 *                       merge itself is pinned to it with --match-head-commit.
 *
 * ---- what this does not claim ----
 *
 * `via` records how an approval arrived ("prompt:<id>" for a command the PM
 * typed). It is a claim, not a proof: anything running as the same user can
 * write the same string. devolps reconciles each `prompt:` approval against
 * its own record of typed commands; this module only refuses an approval that
 * gives no channel at all.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { appendEvent, readEvents, type ProjectEvent } from "./events";
import { slug } from "./prd";

export const GATE_KINDS = ["prd", "design", "sprint", "merge", "release"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const TRACKS = ["full", "quick", "bugfix"] as const;
export type Track = (typeof TRACKS)[number];

/** The stage a piece of work is about to enter. */
export const STAGES = ["idea", "prfaq", "prd", "design", "backlog", "build"] as const;
export type Stage = (typeof STAGES)[number];

export type GateState = "none" | "requested" | "approved" | "overridden" | "refused" | "stale";

export const isGateKind = (v: string): v is GateKind => (GATE_KINDS as readonly string[]).includes(v);
export const isTrack = (v: string): v is Track => (TRACKS as readonly string[]).includes(v);
export const isStage = (v: string): v is Stage => (STAGES as readonly string[]).includes(v);

/** A bound artifact: a repo-relative path, `prd-section:<epic>` or `head:<sha>`. */
export type Artifact = { ref: string; sha256: string | null };

export type Gate = {
  kind: GateKind;
  subject: string;
  state: GateState;
  /** What the request named, hashed at request time. */
  requested: Artifact[];
  /** What the approval bound, hashed at approval time. */
  approved: Artifact[];
  /** Tasks a sprint gate covers. */
  tasks: string[];
  requestedAt?: number;
  decidedAt?: number;
  via?: string;
  override?: string;
  reason?: string;
  remedy?: string;
  /** Artifacts whose bytes differ from what was approved. */
  changed: string[];
};

export type TrackDecision = { subject: string; track: Track; via: string; at: number };

export type GateBook = {
  gates: Map<string, Gate>;
  tracks: Map<string, TrackDecision>;
};

const gateKey = (kind: string, subject: string) => `${kind}:${subject}`;

/* --------------------------------- hashing -------------------------------- */

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * One epic's section of the PRD, normalised so ticking a box is not a change.
 *
 * The section runs from its `## Phase: <name>` heading to the next heading at
 * the same depth or shallower. Returns null when the epic is not in the PRD.
 */
export const prdSection = (prd: string, epic: string): string | null => {
  const lines = prd.split(/\r?\n/);
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+Phase:\s*(.+?)\s*$/.exec(lines[i]);
    if (m && slug(m[2]) === epic) {
      start = i;
      depth = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h && h[1].length <= depth) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start, end)
    .map((l) => l.replace(/^(\s*[-*+]\s+)\[[ xX]\]/, "$1[ ]"))
    .join("\n");
};

/**
 * The real path of `path` when it is a regular file inside `root`; null otherwise (SR-8).
 *
 * A merged log names the path, so a `..` escape, a symlink out of the root, a
 * folder, a device or a FIFO counts as missing. Nothing here opens the file.
 * The roadmap's PRD source read uses it too.
 */
export const regularFileIn =(root: string, path: string): string | null => {
  try {
    const base = realpathSync(root);
    const file = realpathSync(join(base, path));
    const rel = relative(base, file);
    if (isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
    return statSync(file).isFile() ? file : null;
  } catch {
    return null; // as existsSync did: a path that cannot be resolved is missing
  }
};

/** sha256 of an artifact's current bytes; null when it is not a regular file inside the root. */
export const hashArtifact = (root: string, ref: string, prdPath = "docs/prd.md"): string | null => {
  if (ref.startsWith("head:")) return ref.slice("head:".length) || null;
  if (ref.startsWith("prd-section:")) {
    const file = regularFileIn(root, prdPath);
    if (file === null) return null;
    const section = prdSection(readFileSync(file, "utf8"), ref.slice("prd-section:".length));
    return section === null ? null : sha(section);
  }
  const file = regularFileIn(root, ref);
  return file === null ? null : sha(readFileSync(file, "utf8"));
};

/* ---------------------------------- fold ---------------------------------- */

const asArtifacts = (v: unknown): Artifact[] =>
  Array.isArray(v)
    ? v
        .filter((a): a is { ref: string; sha256?: string | null } => !!a && typeof (a as Artifact).ref === "string")
        .map((a) => ({ ref: a.ref, sha256: a.sha256 ?? null }))
    : [];

/**
 * Every gate and track decision, from the log.
 *
 * A new request reopens a gate: whatever was decided before applies to the
 * previous request, not this one. Unknown event kinds are skipped, as
 * everywhere else in the log.
 */
export const foldGates = (events: readonly ProjectEvent[]): GateBook => {
  const gates = new Map<string, Gate>();
  const tracks = new Map<string, TrackDecision>();

  for (const e of events) {
    const d = e.data ?? {};
    if (e.kind === "track.confirmed") {
      const track = String(d.track ?? "");
      if (isTrack(track) && typeof d.subject === "string") {
        tracks.set(d.subject, { subject: d.subject, track, via: String(d.via ?? ""), at: e.ts });
      }
      continue;
    }
    if (!e.kind.startsWith("gate.")) continue;
    const kind = String(d.kind ?? "");
    const subject = String(d.subject ?? "");
    if (!isGateKind(kind) || !subject) continue;
    const key = gateKey(kind, subject);

    if (e.kind === "gate.requested") {
      gates.set(key, {
        kind,
        subject,
        state: "requested",
        requested: asArtifacts(d.artifacts),
        approved: [],
        tasks: Array.isArray(d.tasks) ? d.tasks.map(String) : [],
        requestedAt: e.ts,
        changed: [],
      });
      continue;
    }

    const gate = gates.get(key);
    if (!gate) continue; // A decision with no request: nothing to decide on.

    if (e.kind === "gate.approved") {
      gate.state = typeof d.override === "string" && d.override ? "overridden" : "approved";
      gate.approved = asArtifacts(d.artifacts);
      gate.via = String(d.via ?? "");
      gate.override = typeof d.override === "string" ? d.override : undefined;
      gate.decidedAt = e.ts;
      gate.reason = undefined;
      gate.remedy = undefined;
    } else if (e.kind === "gate.refused") {
      gate.state = "refused";
      gate.via = String(d.via ?? "");
      gate.reason = typeof d.reason === "string" ? d.reason : undefined;
      gate.remedy = typeof d.remedy === "string" ? d.remedy : undefined;
      gate.decidedAt = e.ts;
    }
  }
  return { gates, tracks };
};

/**
 * Marks approved gates stale where an artifact's bytes changed since approval.
 *
 * `head:` artifacts are never re-hashed here: the merge is pinned to the
 * approved head commit instead, so a pushed commit makes the merge fail, which
 * is the same protection without a network call.
 */
export const withStaleness = (book: GateBook, hash: (ref: string) => string | null): GateBook => {
  for (const gate of Array.from(book.gates.values())) {
    if (gate.state !== "approved" && gate.state !== "overridden") continue;
    gate.changed = gate.approved
      .filter((a) => !a.ref.startsWith("head:") && hash(a.ref) !== a.sha256)
      .map((a) => a.ref);
    if (gate.changed.length) gate.state = "stale";
  }
  return book;
};

export const readGates = (root: string, prdPath?: string): GateBook =>
  withStaleness(foldGates(readEvents(root)), (ref) => hashArtifact(root, ref, prdPath));

/* --------------------------------- writes --------------------------------- */

export class GateError extends Error {}

export const requestGate = (
  root: string,
  input: { kind: GateKind; subject: string; artifacts: string[]; tasks?: string[] },
  prdPath?: string,
): Gate => {
  if (!input.subject) throw new GateError("A gate needs a subject: an epic id, a sprint id, a PR number or a version.");
  const artifacts = input.artifacts.map((ref) => ({ ref, sha256: hashArtifact(root, ref, prdPath) }));
  const missing = artifacts.filter((a) => a.sha256 === null).map((a) => a.ref);
  if (missing.length) {
    throw new GateError(`These artifacts do not exist, so there is nothing to approve: ${missing.join(", ")}`);
  }
  appendEvent(root, {
    kind: "gate.requested",
    data: { kind: input.kind, subject: input.subject, artifacts, tasks: input.tasks ?? [] },
  });
  return readGates(root, prdPath).gates.get(gateKey(input.kind, input.subject))!;
};

const requireVia = (via: string | undefined): string => {
  if (!via || !via.trim()) {
    throw new GateError(
      "An approval must say how it arrived (--via). The PM approves by typing /devolps:approve, " +
        "which records --via prompt:<id>.",
    );
  }
  return via.trim();
};

/**
 * Approves a requested gate, binding it to the artifacts' bytes as they are now.
 *
 * `head` replaces any `head:` artifact for a merge gate, so the approval names
 * the commit the PM actually saw.
 */
export const approveGate = (
  root: string,
  input: { kind: GateKind; subject: string; via?: string; override?: string; head?: string },
  prdPath?: string,
): Gate => {
  const via = requireVia(input.via);
  const gate = readGates(root, prdPath).gates.get(gateKey(input.kind, input.subject));
  if (!gate) {
    throw new GateError(
      `No ${input.kind} gate has been requested for "${input.subject}". The EM requests it first with ` +
        `\`project-companion gate request ${input.kind} ${input.subject} --artifact <file>\`.`,
    );
  }
  const refs = gate.requested.map((a) => a.ref).filter((r) => !(input.head && r.startsWith("head:")));
  if (input.head) refs.push(`head:${input.head}`);
  const artifacts = refs.map((ref) => ({ ref, sha256: hashArtifact(root, ref, prdPath) }));
  const missing = artifacts.filter((a) => a.sha256 === null).map((a) => a.ref);
  if (missing.length) {
    throw new GateError(`These artifacts no longer exist: ${missing.join(", ")}. Request the gate again.`);
  }
  appendEvent(root, {
    kind: "gate.approved",
    data: {
      kind: input.kind,
      subject: input.subject,
      via,
      artifacts,
      ...(input.override ? { override: input.override } : {}),
    },
  });
  return readGates(root, prdPath).gates.get(gateKey(input.kind, input.subject))!;
};

export const refuseGate = (
  root: string,
  input: { kind: GateKind; subject: string; via?: string; reason: string; remedy?: string },
  prdPath?: string,
): Gate => {
  const via = requireVia(input.via);
  if (!input.reason?.trim()) throw new GateError("A refusal needs a reason, so the work can be fixed.");
  const gate = readGates(root, prdPath).gates.get(gateKey(input.kind, input.subject));
  if (!gate) throw new GateError(`No ${input.kind} gate has been requested for "${input.subject}".`);
  appendEvent(root, {
    kind: "gate.refused",
    data: { kind: input.kind, subject: input.subject, via, reason: input.reason, remedy: input.remedy },
  });
  return readGates(root, prdPath).gates.get(gateKey(input.kind, input.subject))!;
};

export const confirmTrack = (
  root: string,
  input: { subject: string; track: Track; via?: string },
): TrackDecision => {
  const via = requireVia(input.via);
  appendEvent(root, { kind: "track.confirmed", data: { subject: input.subject, track: input.track, via } });
  return readGates(root).tracks.get(input.subject)!;
};

/* ---------------------------------- check --------------------------------- */

/** The gates a track needs open before work enters a stage. */
export const requiredGates = (track: Track, stage: Stage): GateKind[] => {
  if (stage === "idea" || stage === "prfaq" || stage === "prd") return [];
  if (track === "full") {
    if (stage === "design") return ["prd"];
    if (stage === "backlog") return ["prd", "design"];
    return ["prd", "design", "sprint"];
  }
  if (track === "quick") return ["prd"];
  return []; // bugfix: no gate before build; a written bugfix spec instead.
};

export type Missing = {
  what: GateKind | "track" | "bugfix-spec" | "task";
  subject: string;
  state: GateState | "unconfirmed" | "absent";
  remedy: string;
};

export type CheckResult = {
  ok: boolean;
  stage: Stage;
  epic?: string;
  task?: string;
  track?: Track;
  missing: Missing[];
};

/** What the check needs to know about a task, without reading the store itself. */
export type TaskRef = { id: string; epic?: string };

const remedyFor = (kind: GateKind, subject: string, gate: Gate | undefined): Missing => {
  if (!gate) {
    return {
      what: kind,
      subject,
      state: "none",
      remedy: `The EM requests the ${kind} gate for ${subject}. Then the PM types \`/devolps:approve ${kind} ${subject}\`.`,
    };
  }
  if (gate.state === "requested") {
    return { what: kind, subject, state: "requested", remedy: `Waiting for the PM to type \`/devolps:approve ${kind} ${subject}\`.` };
  }
  if (gate.state === "refused") {
    return {
      what: kind,
      subject,
      state: "refused",
      remedy: `The PM refused it: ${gate.reason ?? "no reason given"}. Fix it, then request the gate again.`,
    };
  }
  return {
    what: kind,
    subject,
    state: "stale",
    remedy: `Approved files changed since approval (${gate.changed.join(", ")}). Request the gate again for the PM.`,
  };
};

/**
 * May this work enter this stage?
 *
 * Pure: the caller supplies the gate book, the task (if any) and a file check,
 * so every branch is testable without a repository.
 */
export const checkWork = (
  book: GateBook,
  input: { stage: Stage; epic?: string; task?: TaskRef | null; taskId?: string },
  fileExists: (path: string) => boolean,
): CheckResult => {
  const stage = input.stage;
  if (input.taskId && !input.task) {
    return {
      ok: false,
      stage,
      task: input.taskId,
      missing: [{ what: "task", subject: input.taskId, state: "absent", remedy: `No task "${input.taskId}". Check the id with \`project-companion task list\`.` }],
    };
  }
  const task = input.task ?? undefined;
  const epic = input.epic ?? task?.epic;
  const result: CheckResult = { ok: true, stage, epic, task: task?.id, missing: [] };

  if (stage === "idea" || stage === "prfaq" || stage === "prd") return result;

  const decision = (task && book.tracks.get(task.id)) ?? (epic ? book.tracks.get(epic) : undefined);
  const trackSubject = task && book.tracks.has(task.id) ? task.id : epic ?? task?.id ?? "";
  if (!decision) {
    result.ok = false;
    result.missing.push({
      what: "track",
      subject: trackSubject,
      state: "unconfirmed",
      remedy: `The PM confirms the track: \`/devolps:approve track ${trackSubject} <full|quick|bugfix>\`.`,
    });
    return result;
  }
  result.track = decision.track;

  for (const kind of requiredGates(decision.track, stage)) {
    if (kind === "sprint") {
      const covering = Array.from(book.gates.values()).filter(
        (g) => g.kind === "sprint" && task && g.tasks.includes(task.id),
      );
      const open = covering.find((g) => g.state === "approved" || g.state === "overridden");
      if (!open) {
        const latest = covering.sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0))[0];
        result.missing.push(
          latest
            ? remedyFor("sprint", latest.subject, latest)
            : {
                what: "sprint",
                subject: task?.id ?? "",
                state: "none",
                remedy: "No approved sprint includes this task. The EM proposes a sprint with it, and the PM approves the sprint gate.",
              },
        );
      }
      continue;
    }
    const subject = epic ?? task?.id ?? "";
    const gate = book.gates.get(gateKey(kind, subject));
    if (!gate || (gate.state !== "approved" && gate.state !== "overridden")) {
      result.missing.push(remedyFor(kind, subject, gate));
    }
  }

  if (decision.track === "bugfix" && stage === "build" && task) {
    const spec = `specs/bugs/${task.id}/bugfix.md`;
    if (!fileExists(spec)) {
      result.missing.push({
        what: "bugfix-spec",
        subject: task.id,
        state: "absent",
        remedy: `Write ${spec} (observed, expected, steps to reproduce, root cause, fix, regression test) before the fix starts.`,
      });
    }
  }

  result.ok = result.missing.length === 0;
  return result;
};

/** Every gate, newest first, for `gate status`. */
export const listGates = (book: GateBook): Gate[] =>
  Array.from(book.gates.values()).sort((a, b) => (b.decidedAt ?? b.requestedAt ?? 0) - (a.decidedAt ?? a.requestedAt ?? 0));
