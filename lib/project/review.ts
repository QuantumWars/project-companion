/**
 * Preparing a change for review, and checking what comes back.
 *
 * The expensive part of a good review is not the judgement, it is knowing what
 * the change is for -- the spec it implements, the criteria it has to meet,
 * whether those criteria still pass, what else depends on the code it touched,
 * and which of that the reviewer can skip. Assembling all of that is
 * deterministic retrieval, so it happens here, where it costs nothing.
 *
 * The judgement is not here, and deliberately. This project never calls a
 * model: it writes a packet, the agent the developer already has reads it, and
 * the findings come back through `report_findings`. That keeps the tool free,
 * offline and harness-agnostic, and it is why the effort goes into context
 * rather than inference.
 *
 * What DOES happen here is the last step, which needs no model at all: a
 * finding whose `file:line` does not land inside the diff is dropped. Not
 * ranked lower -- dropped. A review that comments on code the change did not
 * touch is worse than no review, because it costs the reader attention and
 * teaches them to skim.
 */

import type { GitCommit, DiffHunk } from "./git";
import type { Component } from "./component";
import { resolveComponent } from "./component";

/* ------------------------------- gatekeeper ------------------------------- */

const GENERATED = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /\.min\.(js|css)$/,
  /(^|\/)__snapshots__\//,
];

const DOCS = /\.(md|mdx|txt|rst)$/i;

export type FileClass = "generated" | "docs" | "cosmetic" | "logic";

/**
 * What kind of change a file received.
 *
 * The cheapest possible win, and the one every review pipeline starts with:
 * most of a diff does not need a reviewer's attention, and deciding that with a
 * regex costs nothing. A lockfile is machine-written, a docs change is read
 * differently, and a file where only whitespace moved is not a change to the
 * program.
 *
 * `cosmetic` is judged on the diff rather than the path, because whether a file
 * matters depends on what happened to it and not on where it lives.
 */
export const classify = (
  file: { path: string; insertions: number; deletions: number },
): FileClass => {
  if (GENERATED.some((pattern) => pattern.test(file.path))) return "generated";
  if (DOCS.test(file.path)) return "docs";
  // A pure move: as many lines out as in, and few enough that a rename or a
  // reformat is far likelier than a rewrite.
  if (file.insertions === file.deletions && file.insertions > 0 && file.insertions <= 2) {
    return "cosmetic";
  }
  return "logic";
};

export type RoutedFile = {
  path: string;
  kind: FileClass;
  componentId?: string;
  insertions: number;
  deletions: number;
};

/**
 * Splits a commit into what needs reviewing and by whom.
 *
 * Routing is per component, so a change spanning three of them becomes three
 * scoped reviews with three owners rather than one undifferentiated blob that
 * nobody feels responsible for.
 */
export const route = (
  commit: Pick<GitCommit, "files">,
  components: readonly Component[],
): RoutedFile[] =>
  commit.files.map((file) => ({
    path: file.path,
    kind: classify(file),
    componentId: resolveComponent(file.path, components)?.componentId,
    insertions: file.insertions,
    deletions: file.deletions,
  }));

/* --------------------------------- grounding ------------------------------ */

export type Finding = {
  file: string;
  line: number;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
};

export type Grounded = {
  kept: Finding[];
  dropped: { finding: Finding; reason: "file-not-in-diff" | "line-not-changed" }[];
};

/**
 * Drops every finding that does not land on a line the change touched.
 *
 * The one part of the pipeline that needs no model and no judgement, which is
 * exactly why it is worth having: it puts a mechanical floor under the false
 * positive rate that does not depend on the reviewer being careful today.
 *
 * The reason is kept for each drop. "It commented on a file the diff does not
 * contain" and "it commented on an unchanged line of a file it does" are
 * different failures, and telling them apart is how the prompt gets fixed.
 */
export const ground = (findings: readonly Finding[], hunks: readonly DiffHunk[]): Grounded => {
  const byFile = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const list = byFile.get(hunk.path) ?? [];
    list.push(hunk);
    byFile.set(hunk.path, list);
  }

  const kept: Finding[] = [];
  const dropped: Grounded["dropped"] = [];

  for (const finding of findings) {
    const inFile = byFile.get(finding.file);
    if (!inFile) {
      dropped.push({ finding, reason: "file-not-in-diff" });
      continue;
    }
    const onLine = inFile.some(
      (h) => finding.line >= h.start && finding.line < h.start + h.lines,
    );
    if (onLine) kept.push(finding);
    else dropped.push({ finding, reason: "line-not-changed" });
  }

  return { kept, dropped };
};

/* ---------------------------------- packet -------------------------------- */

export type PacketInput = {
  commit: Pick<GitCommit, "sha" | "short" | "subject" | "body" | "author" | "at">;
  routed: RoutedFile[];
  components: readonly Component[];
  /** The features the touched components are responsible for. */
  spec: { componentId: string; featureId: string; title: string; criteria: { text: string; done: boolean }[] }[];
  /** What `verify` last said about those features. */
  checks: { featureId: string; ok: boolean; command: string }[];
  /** Undeclared coupling this change is part of, if any. */
  drift: { from: string; to: string }[];
};

/**
 * The review packet.
 *
 * Markdown rather than JSON because a person reads it too -- the whole argument
 * for assembling this is that it makes scarce reviewer attention go further,
 * and a reviewer who cannot read the thing gets no benefit.
 *
 * The reading order is the most valuable line in it. A diff is presented
 * alphabetically by path, which is never the order in which it makes sense;
 * logic first, by size, is.
 */
export const packet = (input: PacketInput): string => {
  const { commit, routed } = input;
  const logic = routed.filter((f) => f.kind === "logic").sort((a, b) => b.insertions - a.insertions);
  const skippable = routed.filter((f) => f.kind !== "logic");
  const touched = Array.from(new Set(routed.map((f) => f.componentId).filter(Boolean)));

  const lines: string[] = [
    `# Review: ${commit.subject}`,
    "",
    `${commit.short} by ${commit.author} on ${commit.at.slice(0, 10)}`,
    "",
  ];

  if (commit.body.trim()) {
    lines.push("## What the author says", "", commit.body.trim(), "");
  }

  lines.push(
    "## What this is for",
    "",
    touched.length
      ? `Touches ${touched.join(", ")}.`
      : "Touches no component the catalog knows about, so nothing below is scoped.",
    "",
  );

  for (const feature of input.spec) {
    const met = feature.criteria.filter((c) => c.done).length;
    const check = input.checks.find((c) => c.featureId === feature.featureId);
    lines.push(
      `**${feature.title}** (${feature.componentId}) — ${met}/${feature.criteria.length} criteria` +
        (check ? `, \`${check.command}\` ${check.ok ? "passes" : "**fails**"}` : ", no check declared"),
    );
    for (const criterion of feature.criteria) {
      lines.push(`- [${criterion.done ? "x" : " "}] ${criterion.text}`);
    }
    lines.push("");
  }

  lines.push(
    "## Read in this order",
    "",
    ...(logic.length
      ? logic.map(
          (f, i) =>
            `${i + 1}. \`${f.path}\` (+${f.insertions} −${f.deletions})` +
            (f.componentId ? ` — ${f.componentId}` : " — unowned"),
        )
      : ["Nothing here changes behaviour."]),
    "",
  );

  if (skippable.length) {
    lines.push(
      "## Skip these",
      "",
      ...skippable.map((f) => `- \`${f.path}\` — ${f.kind}`),
      "",
    );
  }

  if (input.drift.length) {
    lines.push(
      "## Boundaries this crosses",
      "",
      ...input.drift.map((d) => `- ${d.from} → ${d.to} is not on the canvas`),
      "",
    );
  }

  lines.push(
    "## What to report",
    "",
    "Anchor every finding to a `file:line` **inside this diff**. A finding on a line",
    "the change did not touch is dropped automatically, so it costs you the effort and",
    "reaches nobody. Report through `report_findings`.",
    "",
  );

  return lines.join("\n");
};

/* ------------------------------ what was found ---------------------------- */

export type StoredFinding = Finding & {
  id: string;
  sha: string;
  componentId?: string;
  at: number;
  resolved?: boolean;
};

/**
 * Findings that survived grounding, folded out of the log.
 *
 * Recorded rather than returned and forgotten, because a review whose output
 * has nowhere to go is half a loop: the reviewer is told, and the next person
 * to open that component is not. Keyed by sha, file and line, so re-running a
 * review does not produce a second copy of a finding nobody has acted on.
 *
 * A resolved finding stays in the log -- the log is append-only and that is the
 * point -- but stops being returned. What it was is recoverable; what it is is
 * closed.
 */
export const findingsFrom = (
  events: readonly { kind: string; ts: number; componentId?: string; data: Record<string, unknown> }[],
): StoredFinding[] => {
  const open = new Map<string, StoredFinding>();

  for (const event of events) {
    const id = typeof event.data.findingId === "string" ? event.data.findingId : undefined;
    if (!id) continue;

    if (event.kind === "review.finding") {
      open.set(id, {
        id,
        sha: String(event.data.sha ?? ""),
        file: String(event.data.file ?? ""),
        line: Number(event.data.line ?? 0),
        severity: (event.data.severity as Finding["severity"]) ?? "medium",
        title: String(event.data.title ?? ""),
        detail: String(event.data.detail ?? ""),
        componentId: event.componentId,
        at: event.ts,
      });
      continue;
    }
    if (event.kind === "review.resolved") open.delete(id);
  }

  const order = { high: 0, medium: 1, low: 2 };
  return Array.from(open.values()).sort(
    (a, b) => order[a.severity] - order[b.severity] || b.at - a.at,
  );
};

/** Stable across re-reviews, so the same finding is not recorded twice. */
export const findingId = (sha: string, finding: Finding): string =>
  `${sha}:${finding.file}:${finding.line}:${finding.title.slice(0, 40)}`;
