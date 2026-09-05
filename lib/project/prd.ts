/**
 * Reading and editing the PRD.
 *
 * `docs/prd.md` is the source of truth for the feature list, and both a human
 * and a coding agent edit it directly. That constraint drives every decision
 * here:
 *
 * 1. We PARSE with a real CommonMark parser, never a line scanner. The repo's
 *    other parsers (`lib/arch/import/sql-ddl.ts`) are deliberately tolerant and
 *    ignore what they do not understand, which is safe because they only read.
 *    This module writes back, where "ignores what it doesn't understand"
 *    becomes "OVERWRITES what it doesn't understand" -- a `## Deploy` inside a
 *    fenced block, a setext heading, an indented code block.
 *
 * 2. We never stringify the AST back out. `remark-stringify` would normalise
 *    bullet markers, emphasis, escaping and indentation, rewriting the whole
 *    document on every save. Instead `applyEdits` splices only the exact
 *    ranges the parser produced, leaving every other byte untouched.
 *
 * 3. Offsets are UTF-16 indices into the decoded string, never byte offsets.
 *    `"\u{1F680}".length` is 2 but its byte length is 4; mixing the two splices
 *    mid-character. Hash the bytes, index the string.
 *
 * 4. Anchors never leave this process. Callers address edits semantically, by
 *    feature id and field, and ranges are re-derived from a fresh parse on
 *    every write. An offset that never round-trips can never go stale.
 */

import { createHash } from "node:crypto";

import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";

import type { AcceptanceCriterion, FeatureIdSource } from "./types";

/* --------------------------------- ranges --------------------------------- */

/** A half-open [start, end) span of UTF-16 indices into the source string. */
export type Range = { start: number; end: number };

export type ParsedCriterion = AcceptanceCriterion & {
  /** The whole list item, including its marker and any continuation lines. */
  range: Range;
  /** Just the label text, so ticking a box never disturbs indentation. */
  textRange: Range;
  /** The `[ ]` / `[x]` box itself. */
  checkboxRange: Range;
};

export type ParsedFeature = {
  id: string;
  idSource: FeatureIdSource;
  title: string;
  summary?: string;
  paths?: string[];
  /** A command that proves this feature works. See `VERIFY_LINE`. */
  verify?: string;
  acceptance: ParsedCriterion[];
  phaseId?: string;
  /** Document order across the whole PRD. */
  order: number;
  depth: number;
  /** Everything from the heading to just before the next heading. */
  blockRange: Range;
  /** The heading's inline content, excluding `## ` and any closing `##`. */
  titleRange: Range;
  /** Present when the PRD already carries an id marker for this feature. */
  markerRange?: Range;
  /** Where a marker line should be inserted when backfilling. */
  markerInsertAt: number;
  summaryRange?: Range;
  /** Where a summary paragraph would go when the feature has none. */
  summaryInsertAt: number;
  pathsRange?: Range;
  verifyRange?: Range;
  acceptanceRange?: Range;
  /** Where a new criterion is appended. */
  acceptanceInsertAt: number;
};

export type ParsedPhase = {
  id: string;
  name: string;
  goal?: string;
  order: number;
  titleRange: Range;
  blockRange: Range;
};

export type ParsedPrd = {
  title?: string;
  phases: ParsedPhase[];
  features: ParsedFeature[];
  /**
   * Problems worth showing rather than swallowing: duplicate ids, features
   * whose id is still slug-derived, headings that look like phases but are not.
   */
  warnings: string[];
};

/* --------------------------------- helpers -------------------------------- */

/** sha256 of the raw bytes. Bytes, because whitespace moves every anchor. */
export const hashSource = (source: string): string =>
  createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16);

/**
 * Slugs a heading, folding accents rather than dropping them.
 *
 * Decompose (NFD) and strip the combining marks, so an accented heading slugs
 * to plain ASCII instead of losing the letter entirely. This also makes the
 * composed and decomposed spellings agree -- macOS types the decomposed form,
 * and the difference is invisible in a diff but would otherwise produce two
 * different ids for the same heading.
 *
 * Normalisation happens HERE and nowhere else: it changes string length, so it
 * must never be applied to text that offsets point into.
 */
export const slug = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const ID_MARKER = /^<!--\s*id:\s*([a-z0-9][a-z0-9-]*)\s*-->$/;
const PHASE_HEADING = /^phase\s*:\s*(.+)$/i;
const PATHS_LINE = /^paths\s*:\s*(.+)$/i;
/**
 * The command that proves this feature works.
 *
 * `Verify: npm test -- auth` beside `Paths:`, because they answer the same
 * shape of question -- where the feature lives, and how you know it is done.
 * A criterion may carry its own, so a feature with ten boxes is not one
 * all-or-nothing check.
 */
const VERIFY_LINE = /^verify\s*:\s*(.+)$/i;
const GOAL_LINE = /^goal\s*:\s*(.+)$/i;

type Node = {
  type: string;
  value?: string;
  depth?: number;
  checked?: boolean | null;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const span = (node: Node): Range => ({
  start: node.position?.start.offset ?? 0,
  end: node.position?.end.offset ?? 0,
});

/** Raw source for a node's own span. */
const raw = (source: string, node: Node): string => {
  const { start, end } = span(node);
  return source.slice(start, end);
};

/**
 * Literal source text of a heading or paragraph's inline content.
 *
 * Deliberately NOT the rendered text. A path glob like `app/**, lib/**` is
 * parsed by CommonMark as strong emphasis, so the rendered text silently drops
 * every asterisk and turns the glob into `app/, lib/`. Since this text is what
 * gets written back to the file, it has to be exactly what the file says.
 */
const literal = (source: string, node: Node): string => {
  const kids = node.children ?? [];
  if (!kids.length) return raw(source, node);
  return source.slice(span(kids[0]).start, span(kids[kids.length - 1]).end);
};

/** Rendered text, used only where markup should collapse away. */
const textOf = (node: Node): string => {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(textOf).join("");
};

/** The inline content range of a heading, excluding `##` and any closing `##`. */
const headingTextRange = (node: Node): Range => {
  const kids = node.children ?? [];
  if (!kids.length) return span(node);
  return { start: span(kids[0]).start, end: span(kids[kids.length - 1]).end };
};

/* --------------------------------- parsing -------------------------------- */

export const parsePrd = (source: string): ParsedPrd => {
  const tree = fromMarkdown(source, {
    extensions: [frontmatter(["yaml"]), gfmTaskListItem()],
    mdastExtensions: [frontmatterFromMarkdown(["yaml"]), gfmTaskListItemFromMarkdown()],
  }) as unknown as Node;

  // Only top-level blocks are considered. Anything nested -- inside a fence, an
  // indented code block, an HTML block, front matter -- is never reached, which
  // is precisely why a real parser is used instead of a line scan.
  const blocks = (tree.children ?? []).filter((n) => n.type !== "yaml");

  const phases: ParsedPhase[] = [];
  const features: ParsedFeature[] = [];
  const warnings: string[] = [];
  let title: string | undefined;

  const endOfBlock = (from: number): number => {
    for (let j = from + 1; j < blocks.length; j++) {
      if (blocks[j].type === "heading") return span(blocks[j]).start;
    }
    return source.length;
  };

  // A phase owns the headings *below* it. A heading at the phase's own depth or
  // shallower is a sibling, not a member -- so `## Refunds` after
  // `## Phase: Foundations` is a standalone feature, not part of that phase.
  let currentPhase: string | undefined;
  let phaseDepth = 0;

  for (let i = 0; i < blocks.length; i++) {
    const node = blocks[i];
    if (node.type !== "heading") continue;

    const text = literal(source, node).trim();
    const depth = node.depth ?? 1;

    if (depth === 1 && title === undefined) {
      title = text;
      currentPhase = undefined;
      continue;
    }

    if (currentPhase !== undefined && depth <= phaseDepth) {
      currentPhase = undefined;
    }

    const blockRange = { start: span(node).start, end: endOfBlock(i) };
    const phaseMatch = PHASE_HEADING.exec(text);

    if (phaseMatch) {
      const name = phaseMatch[1].trim();
      const id = slug(name) || `phase-${phases.length + 1}`;
      let goal: string | undefined;

      for (let j = i + 1; j < blocks.length && blocks[j].type !== "heading"; j++) {
        if (blocks[j].type !== "paragraph") continue;
        const m = GOAL_LINE.exec(literal(source, blocks[j]).trim());
        if (m) {
          goal = m[1].trim();
          break;
        }
      }

      phases.push({
        id,
        name,
        goal,
        order: phases.length,
        titleRange: headingTextRange(node),
        blockRange,
      });
      currentPhase = id;
      phaseDepth = depth;
      continue;
    }

    features.push(
      readFeature(source, blocks, i, {
        node,
        text,
        depth,
        blockRange,
        phaseId: currentPhase,
        order: features.length,
      }),
    );
  }

  // Surface id problems rather than silently resolving them: auto-renumbering a
  // duplicate is exactly what detaches every task pointing at it.
  const seen = new Map<string, ParsedFeature>();
  for (const feature of features) {
    const first = seen.get(feature.id);
    if (first) {
      warnings.push(
        `Duplicate feature id "${feature.id}" on "${feature.title}" (already used by "${first.title}").`,
      );
      continue;
    }
    seen.set(feature.id, feature);
  }

  const unstamped = features.filter((f) => f.idSource === "slug").length;
  if (unstamped) {
    warnings.push(
      `${unstamped} feature${unstamped === 1 ? "" : "s"} still identified by heading slug; renaming ${
        unstamped === 1 ? "it" : "them"
      } in the PRD would orphan linked tasks.`,
    );
  }

  return { title, phases, features, warnings };
};

const readFeature = (
  source: string,
  blocks: Node[],
  index: number,
  ctx: {
    node: Node;
    text: string;
    depth: number;
    blockRange: Range;
    phaseId?: string;
    order: number;
  },
): ParsedFeature => {
  const { node, text, depth, blockRange, phaseId, order } = ctx;

  let id = "";
  let idSource: FeatureIdSource = "slug";
  let markerRange: Range | undefined;
  let summary: string | undefined;
  let summaryRange: Range | undefined;
  let paths: string[] | undefined;
  let pathsRange: Range | undefined;
  let verifyCommand: string | undefined;
  let verifyRange: Range | undefined;
  let acceptance: ParsedCriterion[] = [];
  let acceptanceRange: Range | undefined;

  const headingEnd = span(node).end;

  for (let j = index + 1; j < blocks.length && blocks[j].type !== "heading"; j++) {
    const block = blocks[j];

    if (block.type === "html" && !markerRange) {
      const m = ID_MARKER.exec(textOf(block).trim());
      if (m) {
        id = m[1];
        idSource = "marker";
        markerRange = span(block);
        continue;
      }
    }

    if (block.type === "paragraph") {
      const body = literal(source, block).trim();
      const pathsMatch = PATHS_LINE.exec(body);
      if (pathsMatch && !pathsRange) {
        paths = pathsMatch[1]
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        pathsRange = span(block);
        continue;
      }
      const verifyMatch = VERIFY_LINE.exec(body);
      if (verifyMatch && !verifyRange) {
        verifyCommand = verifyMatch[1].trim();
        verifyRange = span(block);
        continue;
      }
      if (!pathsMatch && !verifyMatch && summary === undefined) {
        summary = body;
        summaryRange = span(block);
      }
      continue;
    }

    if (block.type === "list" && !acceptanceRange) {
      const items = (block.children ?? []).filter((c) => c.checked === true || c.checked === false);
      if (items.length) {
        acceptance = items.map((item) => readCriterion(source, item));
        acceptanceRange = span(block);
      }
    }
  }

  if (!id) id = slug(text) || `feature-${order + 1}`;

  return {
    id,
    idSource,
    title: text,
    summary,
    paths,
    acceptance,
    phaseId,
    order,
    depth,
    blockRange,
    titleRange: headingTextRange(node),
    markerRange,
    // A marker goes on its own line directly after the heading. Appending it to
    // the heading itself would make it part of the inline content and change
    // the anchor GitHub generates for that heading.
    markerInsertAt: headingEnd,
    summaryRange,
    summaryInsertAt: markerRange ? markerRange.end : headingEnd,
    pathsRange,
    verify: verifyCommand,
    verifyRange,
    acceptanceRange,
    acceptanceInsertAt: acceptanceRange
      ? acceptanceRange.end
      : pathsRange?.end ?? summaryRange?.end ?? (markerRange ? markerRange.end : headingEnd),
  };
};

const readCriterion = (source: string, item: Node): ParsedCriterion => {
  const range = span(item);
  const raw = source.slice(range.start, range.end);

  // Locate the checkbox within the item so ticking it rewrites three characters
  // and nothing else -- not the marker, not the indentation, not a nested list.
  const box = /\[[ xX]\]/.exec(raw);
  const boxStart = range.start + (box?.index ?? 0);
  const checkboxRange = { start: boxStart, end: boxStart + (box?.[0].length ?? 3) };

  const firstPara = (item.children ?? []).find((c) => c.type === "paragraph");
  const textRange = firstPara ? span(firstPara) : { start: checkboxRange.end, end: range.end };

  // The label starts after the checkbox even though the paragraph node begins
  // at it, because the GFM extension leaves the box inside the paragraph span.
  const labelStart = Math.max(textRange.start, checkboxRange.end);
  const label = source.slice(labelStart, textRange.end);
  const lead = label.length - label.trimStart().length;

  return {
    id: slug(label) || `criterion-${boxStart}`,
    text: label.trim(),
    done: item.checked === true,
    range,
    textRange: { start: labelStart + lead, end: textRange.end },
    checkboxRange,
  };
};

/* --------------------------------- editing -------------------------------- */

/**
 * An edit is addressed by feature id and field, never by offset.
 *
 * Offsets are re-derived from a fresh parse inside `applyOps`, so a range can
 * never be stale by the time it is used. This is what makes it safe for the
 * browser and an agent to edit the same file: the client says *what* it wants
 * changed, and the server works out *where* that is, right now.
 */
export type PrdOp =
  | { op: "setTitle"; featureId: string; value: string }
  | { op: "setSummary"; featureId: string; value: string }
  | { op: "setPaths"; featureId: string; value: string[] }
  | { op: "setVerify"; featureId: string; value: string | null }
  | { op: "setCriterion"; featureId: string; criterionId: string; done?: boolean; text?: string }
  | { op: "addCriterion"; featureId: string; text: string }
  | { op: "removeCriterion"; featureId: string; criterionId: string }
  | { op: "addFeature"; title: string; phaseId?: string; summary?: string }
  | { op: "removeFeature"; featureId: string }
  | { op: "addPhase"; name: string; goal?: string }
  /** Backfill `<!-- id: -->` markers for every slug-identified feature. */
  | { op: "stampIds" };

type Edit = { range: Range; replacement: string; /** for diagnostics */ what: string };

/** The document's dominant line ending, so an edit never mixes CRLF and LF. */
const lineEndingOf = (source: string): string =>
  (source.match(/\r\n/g)?.length ?? 0) > (source.match(/(?<!\r)\n/g)?.length ?? 0) ? "\r\n" : "\n";

export class PrdEditError extends Error {}

const featureById = (prd: ParsedPrd, id: string): ParsedFeature => {
  const found = prd.features.find((f) => f.id === id);
  if (!found) throw new PrdEditError(`No feature "${id}" in the PRD.`);
  return found;
};

/**
 * Applies semantic edits to a PRD, touching only the ranges it owns.
 *
 * Everything the parser did not produce a range for -- intro prose, tables,
 * images, code, HTML -- is preserved byte for byte. The result is re-parsed and
 * checked before being returned, so a bad splice fails loudly here rather than
 * silently corrupting a document.
 */
export const applyOps = (source: string, ops: PrdOp[]): string => {
  const prd = parsePrd(source);
  const eol = lineEndingOf(source);
  const edits: Edit[] = [];

  /**
   * Lazy marker backfill: any edit that already touches a feature stamps its
   * id at the same time. Reading a PRD never writes to it, so markers accrue
   * only on features someone actually worked on.
   */
  const stamped = new Set<string>();
  const stamp = (feature: ParsedFeature) => {
    if (feature.idSource === "marker" || stamped.has(feature.id)) return;
    stamped.add(feature.id);
    edits.push({
      range: { start: feature.markerInsertAt, end: feature.markerInsertAt },
      replacement: `${eol}<!-- id: ${feature.id} -->`,
      what: `stamp ${feature.id}`,
    });
  };

  const criterionLine = (text: string, done = false) => `- [${done ? "x" : " "}] ${text}`;

  for (const op of ops) {
    switch (op.op) {
      case "stampIds": {
        for (const feature of prd.features) stamp(feature);
        break;
      }

      case "setTitle": {
        const feature = featureById(prd, op.featureId);
        // Stamp FIRST: once the heading text changes, a slug-derived id no
        // longer matches the heading, and every task pointing here is orphaned.
        stamp(feature);
        edits.push({ range: feature.titleRange, replacement: op.value, what: `title ${feature.id}` });
        break;
      }

      case "setSummary": {
        const feature = featureById(prd, op.featureId);
        stamp(feature);
        if (feature.summaryRange) {
          edits.push({ range: feature.summaryRange, replacement: op.value, what: `summary ${feature.id}` });
        } else {
          edits.push({
            range: { start: feature.summaryInsertAt, end: feature.summaryInsertAt },
            replacement: `${eol}${eol}${op.value}`,
            what: `summary+ ${feature.id}`,
          });
        }
        break;
      }

      case "setPaths": {
        const feature = featureById(prd, op.featureId);
        stamp(feature);
        const line = `Paths: ${op.value.join(", ")}`;
        if (feature.pathsRange) {
          edits.push({ range: feature.pathsRange, replacement: line, what: `paths ${feature.id}` });
        } else {
          const at = feature.summaryRange?.end ?? feature.summaryInsertAt;
          edits.push({ range: { start: at, end: at }, replacement: `${eol}${eol}${line}`, what: `paths+ ${feature.id}` });
        }
        break;
      }

      case "setVerify": {
        const feature = featureById(prd, op.featureId);
        stamp(feature);
        if (op.value === null) {
          // Removing takes the blank line before it too, or the document grows
          // a gap every time somebody clears a command.
          if (feature.verifyRange) {
            edits.push({
              range: { start: feature.verifyRange.start, end: feature.verifyRange.end },
              replacement: "",
              what: `verify- ${feature.id}`,
            });
          }
          break;
        }
        const line = `Verify: ${op.value}`;
        if (feature.verifyRange) {
          edits.push({ range: feature.verifyRange, replacement: line, what: `verify ${feature.id}` });
        } else {
          const at = feature.pathsRange?.end ?? feature.summaryRange?.end ?? feature.summaryInsertAt;
          edits.push({
            range: { start: at, end: at },
            replacement: `${eol}${eol}${line}`,
            what: `verify+ ${feature.id}`,
          });
        }
        break;
      }

      case "setCriterion": {
        const feature = featureById(prd, op.featureId);
        const criterion = feature.acceptance.find((c) => c.id === op.criterionId);
        if (!criterion) throw new PrdEditError(`No criterion "${op.criterionId}" on "${op.featureId}".`);
        stamp(feature);
        if (op.done !== undefined) {
          // Three characters. Not the marker, not the indent, not a nested list.
          edits.push({
            range: criterion.checkboxRange,
            replacement: op.done ? "[x]" : "[ ]",
            what: `check ${criterion.id}`,
          });
        }
        if (op.text !== undefined) {
          edits.push({ range: criterion.textRange, replacement: op.text, what: `criterion ${criterion.id}` });
        }
        break;
      }

      case "addCriterion": {
        const feature = featureById(prd, op.featureId);
        stamp(feature);
        const at = feature.acceptanceInsertAt;
        const lead = feature.acceptanceRange ? eol : `${eol}${eol}`;
        edits.push({
          range: { start: at, end: at },
          replacement: `${lead}${criterionLine(op.text)}`,
          what: `criterion+ ${feature.id}`,
        });
        break;
      }

      case "removeCriterion": {
        const feature = featureById(prd, op.featureId);
        const criterion = feature.acceptance.find((c) => c.id === op.criterionId);
        if (!criterion) throw new PrdEditError(`No criterion "${op.criterionId}" on "${op.featureId}".`);
        stamp(feature);
        // Take the newline before the item too, so removing one does not leave
        // a blank line behind.
        const start = Math.max(0, source.lastIndexOf("\n", criterion.range.start - 1));
        edits.push({ range: { start, end: criterion.range.end }, replacement: "", what: `criterion- ${criterion.id}` });
        break;
      }

      case "removeFeature": {
        const feature = featureById(prd, op.featureId);
        edits.push({ range: feature.blockRange, replacement: "", what: `feature- ${feature.id}` });
        break;
      }

      case "addFeature": {
        const phase = op.phaseId ? prd.phases.find((p) => p.id === op.phaseId) : undefined;
        if (op.phaseId && !phase) throw new PrdEditError(`No phase "${op.phaseId}" in the PRD.`);
        const depth = phase ? 3 : 2;
        const at = phase ? phase.blockRange.end : source.length;
        const id = uniqueId(prd, slug(op.title) || "feature");
        const body = [
          `${"#".repeat(depth)} ${op.title}`,
          `<!-- id: ${id} -->`,
          ...(op.summary ? ["", op.summary] : []),
        ].join(eol);
        // A file that does not end in a newline needs one before an append.
        const lead = at === 0 || source.slice(0, at).endsWith("\n") ? "" : eol;
        edits.push({ range: { start: at, end: at }, replacement: `${lead}${body}${eol}${eol}`, what: `feature+ ${id}` });
        break;
      }

      case "addPhase": {
        const at = source.length;
        const body = [`## Phase: ${op.name}`, ...(op.goal ? ["", `Goal: ${op.goal}`] : [])].join(eol);
        const lead = source.endsWith("\n") ? "" : eol;
        edits.push({ range: { start: at, end: at }, replacement: `${lead}${eol}${body}${eol}`, what: `phase+ ${op.name}` });
        break;
      }
    }
  }

  const next = splice(source, edits);
  verify(source, next, prd, ops);
  return next;
};

const uniqueId = (prd: ParsedPrd, base: string): string => {
  if (!prd.features.some((f) => f.id === base)) return base;
  let n = 2;
  while (prd.features.some((f) => f.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
};

/**
 * Applies edits in one pass, descending by position.
 *
 * Descending is not a style choice: applying ascending shifts every later
 * range by the length delta of every earlier one, so the second edit lands in
 * the wrong place. Overlaps are rejected rather than resolved, because two
 * edits claiming the same bytes means a bug upstream, and guessing which wins
 * is how documents get corrupted.
 */
const splice = (source: string, edits: Edit[]): string => {
  const sorted = [...edits].sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end);

  for (let i = 1; i < sorted.length; i++) {
    const later = sorted[i - 1];
    const earlier = sorted[i];
    const insertions = earlier.range.start === earlier.range.end && later.range.start === later.range.end;
    if (!insertions && earlier.range.end > later.range.start) {
      throw new PrdEditError(
        `Overlapping edits: "${earlier.what}" and "${later.what}" both claim the same text.`,
      );
    }
  }

  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.range.start) + edit.replacement + out.slice(edit.range.end);
  }
  return out;
};

/**
 * Re-parses the result and checks it still says what it should.
 *
 * A millisecond of work that converts silent corruption into a loud failure.
 * The strongest assertion is the last one: every feature the edit did not name
 * must come back byte-identical.
 */
const verify = (before: string, after: string, prd: ParsedPrd, ops: PrdOp[]) => {
  const reparsed = parsePrd(after);

  const removed = ops.flatMap((o) => (o.op === "removeFeature" ? [o.featureId] : []));
  const added = ops.filter((o) => o.op === "addFeature").length;

  const expected = prd.features.filter((f) => !removed.includes(f.id)).length + added;
  if (reparsed.features.length !== expected) {
    throw new PrdEditError(
      `Edit changed the feature count from ${prd.features.length} to ${reparsed.features.length}, expected ${expected}.`,
    );
  }

  for (const id of removed) {
    if (reparsed.features.some((f) => f.id === id)) {
      throw new PrdEditError(`Feature "${id}" was meant to be removed but is still present.`);
    }
  }

  // Features nobody named must be untouched, byte for byte.
  const touched = ops.flatMap((o) =>
    o.op === "setTitle" ||
    o.op === "setSummary" ||
    o.op === "setPaths" ||
    o.op === "setVerify" ||
    o.op === "setCriterion" ||
    o.op === "addCriterion" ||
    o.op === "removeCriterion" ||
    o.op === "removeFeature"
      ? [o.featureId]
      : [],
  );
  const stampsEverything = ops.some((o) => o.op === "stampIds");
  const structural = ops.some((o) => o.op === "addFeature" || o.op === "removeFeature" || o.op === "addPhase");

  if (!stampsEverything && !structural) {
    for (const feature of prd.features) {
      if (touched.includes(feature.id)) continue;
      const now = reparsed.features.find((f) => f.id === feature.id);
      if (!now) throw new PrdEditError(`Feature "${feature.id}" disappeared during an unrelated edit.`);
      const wasText = before.slice(feature.blockRange.start, feature.blockRange.end);
      const nowText = after.slice(now.blockRange.start, now.blockRange.end);
      if (wasText !== nowText) {
        throw new PrdEditError(`Feature "${feature.id}" changed but was not part of the edit.`);
      }
    }
  }
};
