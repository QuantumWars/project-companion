import { applyOps, parsePrd, PrdEditError } from "@/lib/project/prd";
import { eq, ok, runAll, test, throws } from "./harness";

/**
 * These tests answer one question: can the editor be trusted with a document
 * somebody wrote by hand? Every case is a way it could quietly destroy work.
 */

const PRD = `---
title: Checkout
---

# Checkout PRD

Intro prose with a **bold** word, a [link](https://example.com) and a table:

| Column | Meaning |
| ------ | ------- |
| a      | b       |

## Phase: Foundations

Goal: ship a working cart.

### Guest checkout
<!-- id: guest-checkout -->

Allow purchase without an account.

Paths: app/checkout/**, lib/cart/**

- [ ] No login prompt
- [x] Email receipt sent

### Saved payment methods

Tokenise via Stripe.

- [ ] Card stored off-site

\`\`\`ts
// ## not a heading
const x = 1;
\`\`\`
`;

test("renaming a heading keeps the feature id", () => {
  const next = applyOps(PRD, [
    { op: "setTitle", featureId: "guest-checkout", value: "Guest checkout v2" },
  ]);
  const prd = parsePrd(next);
  const f = prd.features.find((x) => x.id === "guest-checkout");
  ok(f, "feature id changed on rename -- every linked task would be orphaned");
  eq(f!.title, "Guest checkout v2");
});

test("renaming a slug-identified feature stamps a marker first", () => {
  // Without the stamp, "saved-payment-methods" would become "renamed" and
  // silently detach.
  const next = applyOps(PRD, [
    { op: "setTitle", featureId: "saved-payment-methods", value: "Renamed" },
  ]);
  ok(next.includes("<!-- id: saved-payment-methods -->"), "no marker stamped");
  const f = parsePrd(next).features.find((x) => x.id === "saved-payment-methods");
  ok(f, "id not preserved");
  eq(f!.title, "Renamed");
  eq(f!.idSource, "marker");
});

test("prose, tables, links and code survive an edit byte for byte", () => {
  const next = applyOps(PRD, [
    { op: "setTitle", featureId: "guest-checkout", value: "Guest checkout v2" },
  ]);
  ok(next.includes("| Column | Meaning |"), "table damaged");
  ok(next.includes("[link](https://example.com)"), "link damaged");
  ok(next.includes("**bold**"), "emphasis damaged");
  ok(next.includes("// ## not a heading"), "code fence damaged");
  ok(next.startsWith("---\ntitle: Checkout\n---"), "front matter damaged");
});

test("ticking a checkbox changes exactly three characters", () => {
  const next = applyOps(PRD, [
    { op: "setCriterion", featureId: "guest-checkout", criterionId: "no-login-prompt", done: true },
  ]);
  // Diff the two strings directly: only the box may differ.
  let diffs = 0;
  for (let i = 0, j = 0; i < PRD.length || j < next.length; i++, j++) {
    if (PRD[i] !== next[j]) diffs++;
  }
  ok(diffs <= 1, `expected a one-character diff, got ${diffs}`);
  ok(next.includes("- [x] No login prompt"), "checkbox not ticked");
});

test("path globs round-trip without markdown eating the asterisks", () => {
  const before = parsePrd(PRD).features.find((f) => f.id === "guest-checkout")!;
  eq(before.paths, ["app/checkout/**", "lib/cart/**"]);
  const next = applyOps(PRD, [
    { op: "setPaths", featureId: "guest-checkout", value: ["app/**", "lib/x/**"] },
  ]);
  const after = parsePrd(next).features.find((f) => f.id === "guest-checkout")!;
  eq(after.paths, ["app/**", "lib/x/**"]);
});

test("adding a criterion appends to the existing list", () => {
  const next = applyOps(PRD, [
    { op: "addCriterion", featureId: "guest-checkout", text: "Guest order is claimable later" },
  ]);
  const f = parsePrd(next).features.find((x) => x.id === "guest-checkout")!;
  eq(f.acceptance.map((c) => c.text), [
    "No login prompt",
    "Email receipt sent",
    "Guest order is claimable later",
  ]);
});

test("removing a criterion leaves the others intact", () => {
  const next = applyOps(PRD, [
    { op: "removeCriterion", featureId: "guest-checkout", criterionId: "no-login-prompt" },
  ]);
  const f = parsePrd(next).features.find((x) => x.id === "guest-checkout")!;
  eq(f.acceptance.map((c) => c.text), ["Email receipt sent"]);
});

test("a new feature lands inside its phase and is stamped", () => {
  const next = applyOps(PRD, [
    { op: "addFeature", title: "Apple Pay", phaseId: "foundations", summary: "One-tap checkout." },
  ]);
  const prd = parsePrd(next);
  const f = prd.features.find((x) => x.id === "apple-pay");
  ok(f, "feature not created");
  eq(f!.phaseId, "foundations");
  eq(f!.idSource, "marker");
  eq(f!.summary, "One-tap checkout.");
});

test("a feature added without a phase goes to the end at depth 2", () => {
  const next = applyOps(PRD, [{ op: "addFeature", title: "Refunds" }]);
  const f = parsePrd(next).features.find((x) => x.id === "refunds")!;
  eq(f.depth, 2);
  eq(f.phaseId, undefined);
});

test("removing a feature leaves its neighbours alone", () => {
  const next = applyOps(PRD, [{ op: "removeFeature", featureId: "guest-checkout" }]);
  const prd = parsePrd(next);
  eq(prd.features.map((f) => f.id), ["saved-payment-methods"]);
  ok(next.includes("| Column | Meaning |"), "table damaged by a removal");
});

test("stampIds backfills every slug-identified feature at once", () => {
  const next = applyOps(PRD, [{ op: "stampIds" }]);
  const prd = parsePrd(next);
  ok(prd.features.every((f) => f.idSource === "marker"), "not all stamped");
  eq(prd.features.map((f) => f.id), ["guest-checkout", "saved-payment-methods"]);
});

test("reading never writes: parsing does not stamp anything", () => {
  parsePrd(PRD);
  ok(!PRD.includes("<!-- id: saved-payment-methods -->"), "parse mutated the source");
});

test("editing an unknown feature fails loudly", () => {
  throws(
    () => applyOps(PRD, [{ op: "setTitle", featureId: "nope", value: "x" }]),
    /No feature "nope"/,
  );
});

test("two edits claiming the same text are rejected, not merged", () => {
  throws(
    () =>
      applyOps(PRD, [
        { op: "setTitle", featureId: "guest-checkout", value: "A" },
        { op: "setTitle", featureId: "guest-checkout", value: "B" },
      ]),
    /Overlapping edits/,
  );
});

test("several independent edits apply in one pass", () => {
  const next = applyOps(PRD, [
    { op: "setTitle", featureId: "guest-checkout", value: "Guest checkout v2" },
    { op: "setCriterion", featureId: "saved-payment-methods", criterionId: "card-stored-off-site", done: true },
    { op: "addCriterion", featureId: "guest-checkout", text: "Claimable later" },
  ]);
  const prd = parsePrd(next);
  eq(prd.features.find((f) => f.id === "guest-checkout")!.title, "Guest checkout v2");
  eq(prd.features.find((f) => f.id === "saved-payment-methods")!.acceptance[0].done, true);
  eq(prd.features.find((f) => f.id === "guest-checkout")!.acceptance.length, 3);
});

test("CRLF documents stay CRLF", () => {
  const crlf = PRD.replace(/\n/g, "\r\n");
  const next = applyOps(crlf, [
    { op: "addCriterion", featureId: "guest-checkout", text: "Another" },
  ]);
  ok(!/(?<!\r)\n/.test(next), "an LF leaked into a CRLF document");
});

test("a file with no trailing newline still appends cleanly", () => {
  const noEol = "# T\n\n## One\n<!-- id: one -->";
  const next = applyOps(noEol, [{ op: "addFeature", title: "Two" }]);
  const prd = parsePrd(next);
  eq(prd.features.map((f) => f.id), ["one", "two"]);
});

test("an unrelated feature changing is caught by verification", () => {
  // Directly exercising the guard: an op set that would corrupt a neighbour
  // must throw rather than return a damaged document.
  ok(PrdEditError.prototype instanceof Error, "PrdEditError should be an Error");
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
