import { hashSource, parsePrd, slug } from "@/lib/project/prd";
import { eq, ok, runAll, test } from "./harness";

/**
 * The PRD parser writes back into a document a human is reading, so every test
 * here is really the same question: does it correctly identify what it owns,
 * and leave everything else alone?
 */

const PRD = `---
title: Checkout
tags: [# not a heading]
---

# Checkout PRD

Some intro prose that must survive untouched.

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

## Phase: Hardening

### Rate limiting

\`\`\`sql
-- ## Not a heading, it is inside a fence
CREATE TABLE x (id uuid);
\`\`\`

- [x] 100 req/min per IP

<!-- ## Also not a heading: it is an HTML comment -->

    ## Indented four spaces, so this is code too

## Café ordering

Unicode heading with a 🚀 in the body.
`;

test("front matter is not mistaken for content", () => {
  const prd = parsePrd(PRD);
  eq(prd.title, "Checkout PRD");
  // `# not a heading` inside the YAML must not become a feature.
  ok(!prd.features.some((f) => f.title.includes("not a heading")), "front matter leaked");
});

test("phases and their goals parse", () => {
  const prd = parsePrd(PRD);
  eq(prd.phases.map((p) => p.id), ["foundations", "hardening"]);
  eq(prd.phases[0].goal, "ship a working cart.");
});

test("features attach to the phase they sit under", () => {
  const prd = parsePrd(PRD);
  // A phase owns the headings BELOW it. `## Cafe ordering` is at the same depth
  // as `## Phase: Hardening`, so it is a sibling and belongs to no phase --
  // which is what the markdown hierarchy actually says.
  eq(
    prd.features.map((f) => [f.id, f.phaseId]),
    [
      ["guest-checkout", "foundations"],
      ["saved-payment-methods", "foundations"],
      ["rate-limiting", "hardening"],
      ["cafe-ordering", undefined],
    ],
  );
});

test("a heading at the phase's own depth ends that phase", () => {
  const prd = parsePrd("# T\n\n## Phase: One\n\n### In phase\n\n## Sibling\n");
  eq(
    prd.features.map((f) => [f.id, f.phaseId]),
    [
      ["in-phase", "one"],
      ["sibling", undefined],
    ],
  );
});

test("a heading inside a fenced block is not a feature", () => {
  const prd = parsePrd(PRD);
  ok(!prd.features.some((f) => f.title.includes("inside a fence")), "fence leaked");
});

test("a heading inside an HTML comment is not a feature", () => {
  const prd = parsePrd(PRD);
  ok(!prd.features.some((f) => f.title.includes("HTML comment")), "html comment leaked");
});

test("an indented code block is not a feature", () => {
  const prd = parsePrd(PRD);
  ok(!prd.features.some((f) => f.title.includes("Indented four")), "indented code leaked");
});

test("id comes from the marker when present, slug otherwise", () => {
  const prd = parsePrd(PRD);
  const guest = prd.features.find((f) => f.id === "guest-checkout")!;
  eq(guest.idSource, "marker");
  const saved = prd.features.find((f) => f.id === "saved-payment-methods")!;
  eq(saved.idSource, "slug");
});

test("summary, paths and acceptance parse", () => {
  const guest = parsePrd(PRD).features.find((f) => f.id === "guest-checkout")!;
  eq(guest.summary, "Allow purchase without an account.");
  eq(guest.paths, ["app/checkout/**", "lib/cart/**"]);
  eq(guest.acceptance.map((c) => [c.text, c.done]), [
    ["No login prompt", false],
    ["Email receipt sent", true],
  ]);
});

test("the Paths: line is not swallowed as the summary", () => {
  const guest = parsePrd(PRD).features.find((f) => f.id === "guest-checkout")!;
  ok(!guest.summary!.startsWith("Paths"), "Paths line became the summary");
});

test("every range is a real slice of the source", () => {
  const prd = parsePrd(PRD);
  for (const f of prd.features) {
    eq(PRD.slice(f.titleRange.start, f.titleRange.end), f.title, `titleRange for ${f.id}`);
    if (f.summaryRange) {
      eq(PRD.slice(f.summaryRange.start, f.summaryRange.end), f.summary!, `summaryRange ${f.id}`);
    }
    for (const c of f.acceptance) {
      eq(PRD.slice(c.textRange.start, c.textRange.end), c.text, `textRange ${f.id}/${c.id}`);
      ok(/^\[[ xX]\]$/.test(PRD.slice(c.checkboxRange.start, c.checkboxRange.end)), "checkbox range");
    }
  }
});

test("unicode does not desynchronise offsets", () => {
  // The 🚀 is a surrogate pair; a byte-offset implementation splices mid-character.
  const cafe = parsePrd(PRD).features.find((f) => f.id === "cafe-ordering")!;
  eq(PRD.slice(cafe.titleRange.start, cafe.titleRange.end), "Café ordering");
  ok(cafe.summary!.includes("🚀"), "emoji lost");
});

test("slug normalises unicode so composed and decomposed agree", () => {
  eq(slug("Café ordering"), "cafe-ordering");
  eq(slug("Café ordering"), slug("Café ordering"));
  eq(slug("Add `--json` flag"), "add-json-flag");
});

test("duplicate ids warn instead of being renumbered", () => {
  const dup = "# T\n\n## Auth\n\n- [ ] a\n\n## Auth\n\n- [ ] b\n";
  const prd = parsePrd(dup);
  ok(prd.warnings.some((w) => w.includes("Duplicate feature id")), "no duplicate warning");
});

test("slug-derived ids are warned about", () => {
  const prd = parsePrd("# T\n\n## Unstamped\n");
  ok(prd.warnings.some((w) => w.includes("heading slug")), "no unstamped warning");
});

test("blockRange stops at the next heading", () => {
  const prd = parsePrd(PRD);
  const guest = prd.features.find((f) => f.id === "guest-checkout")!;
  const block = PRD.slice(guest.blockRange.start, guest.blockRange.end);
  ok(block.includes("Email receipt sent"), "block truncated early");
  ok(!block.includes("Saved payment methods"), "block ran into the next feature");
});

test("hash is stable and whitespace-sensitive", () => {
  eq(hashSource(PRD), hashSource(PRD));
  ok(hashSource(PRD) !== hashSource(PRD + "\n"), "trailing newline must change the hash");
});

test("an empty document parses without throwing", () => {
  const prd = parsePrd("");
  eq(prd.features, []);
  eq(prd.phases, []);
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
