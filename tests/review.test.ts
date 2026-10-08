import { classify, ground, packet, route, type Finding } from "@/lib/project/review";
import type { Component } from "@/lib/project/component";
import type { DiffHunk } from "@/lib/project/git";
import { eq, ok, runAll, test } from "./harness";

const component = (id: string, paths: string[]): Component => ({
  id, title: id, paths, lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

const file = (path: string, insertions = 10, deletions = 2) => ({ path, insertions, deletions });

/* ------------------------------- gatekeeper ------------------------------- */

test("machine-written files are not for a person to read", () => {
  eq(classify(file("package-lock.json", 900, 40)), "generated");
  eq(classify(file("dist/bundle.js")), "generated");
  eq(classify(file("app/x.min.js")), "generated");
  eq(classify(file("tests/__snapshots__/a.snap")), "generated");
});

test("documentation is read differently, so it is separated", () => {
  eq(classify(file("README.md")), "docs");
  eq(classify(file("docs/prd.md")), "docs");
});

test("a one-line swap is cosmetic; a real edit of the same file is not", () => {
  eq(classify(file("lib/a.ts", 1, 1)), "cosmetic");
  eq(classify(file("lib/a.ts", 40, 40)), "logic", "same shape, but far too much of it");
});

test("cosmetic is judged on what happened, not on where the file lives", () => {
  eq(classify(file("lib/deep/nested/thing.ts", 2, 2)), "cosmetic");
  eq(classify(file("lib/deep/nested/thing.ts", 30, 1)), "logic");
});

/* --------------------------------- routing -------------------------------- */

const components = [component("core", ["lib/**"]), component("ui", ["app/**"])];

test("a change is routed to whoever owns each file", () => {
  const routed = route(
    { files: [file("lib/a.ts"), file("app/b.tsx"), file("scripts/c.mjs")] },
    components,
  );
  eq(routed.map((f) => f.componentId), ["core", "ui", undefined]);
});

test("a file nobody owns is still listed, because it still has to be read", () => {
  const routed = route({ files: [file("scripts/c.mjs")] }, components);
  eq(routed.length, 1);
  eq(routed[0].kind, "logic");
});

/* -------------------------------- grounding ------------------------------- */

const hunks: DiffHunk[] = [
  { path: "lib/a.ts", start: 10, lines: 5 },
  { path: "lib/a.ts", start: 40, lines: 1 },
];

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "lib/a.ts", line: 12, severity: "medium", title: "t", detail: "d", ...over,
});

test("a finding on a changed line is kept", () => {
  eq(ground([finding()], hunks).kept.length, 1);
});

test("a finding on a file the change does not contain is dropped", () => {
  const result = ground([finding({ file: "lib/invented.ts" })], hunks);
  eq(result.kept, []);
  eq(result.dropped[0].reason, "file-not-in-diff");
});

test("a finding on a real file but an untouched line is dropped too", () => {
  const result = ground([finding({ line: 300 })], hunks);
  eq(result.kept, []);
  eq(result.dropped[0].reason, "line-not-changed", "the two failures are told apart");
});

test("hunk boundaries are inclusive at the start and exclusive at the end", () => {
  eq(ground([finding({ line: 10 })], hunks).kept.length, 1, "first line of the hunk");
  eq(ground([finding({ line: 14 })], hunks).kept.length, 1, "last line of the hunk");
  eq(ground([finding({ line: 15 })], hunks).kept.length, 0, "one past it");
});

test("a single-line hunk covers exactly its one line", () => {
  eq(ground([finding({ line: 40 })], hunks).kept.length, 1);
  eq(ground([finding({ line: 41 })], hunks).kept.length, 0);
});

test("grounding needs no model, which is the point", () => {
  const many = Array.from({ length: 50 }, (_, i) => finding({ line: i }));
  const result = ground(many, hunks);
  eq(result.kept.length + result.dropped.length, 50, "every finding is accounted for");
});

/* --------------------------------- packet --------------------------------- */

const commit = {
  sha: "a".repeat(40), short: "aaaaaaa", subject: "Do a thing",
  body: "Why it was done.", author: "A Dev", at: "2026-09-01T10:00:00.000Z",
};

test("the packet leads with what the change is for", () => {
  const text = packet({
    commit,
    routed: route({ files: [file("lib/a.ts", 40, 1)] }, components),
    components,
    spec: [{ componentId: "core", featureId: "f", title: "A feature", criteria: [{ text: "it works", done: false }] }],
    checks: [{ featureId: "f", ok: true, command: "npm test" }],
    drift: [],
  });
  ok(text.includes("Why it was done."), "the author's own reasoning is not thrown away");
  ok(text.includes("A feature"), text.slice(0, 200));
  ok(text.includes("- [ ] it works"), "including what it still has to satisfy");
  ok(text.includes("`npm test` passes"));
});

test("the reading order is logic first, biggest first", () => {
  const text = packet({
    commit,
    routed: route(
      { files: [file("lib/small.ts", 5, 0), file("README.md", 90, 0), file("lib/big.ts", 200, 0)] },
      components,
    ),
    components, spec: [], checks: [], drift: [],
  });
  const order = text.slice(text.indexOf("Read in this order"));
  ok(order.indexOf("lib/big.ts") < order.indexOf("lib/small.ts"), "biggest logic change first");
  ok(text.includes("## Skip these"), "and the docs are set aside");
  ok(order.indexOf("README.md") > order.indexOf("Skip these") || !order.includes("1. `README.md`"));
});

test("a change with nothing to read says so rather than showing an empty list", () => {
  const text = packet({
    commit,
    routed: route({ files: [file("package-lock.json", 900, 10)] }, components),
    components, spec: [], checks: [], drift: [],
  });
  ok(text.includes("Nothing here changes behaviour."), text);
});

test("the packet tells the reviewer the rule its findings are held to", () => {
  const text = packet({ commit, routed: [], components, spec: [], checks: [], drift: [] });
  ok(text.includes("inside this diff"), "an unanchored finding is wasted effort, and it says so");
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
