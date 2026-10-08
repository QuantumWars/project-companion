import { dependencyGraph, drift, importsIn, resolveSpecifier } from "@/lib/project/deps";
import type { Component } from "@/lib/project/component";
import { eq, ok, runAll, test } from "./harness";

const component = (id: string, paths: string[]): Component => ({
  id,
  title: id,
  paths,
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** An in-memory repo: no filesystem, so the graph rules are what is tested. */
const repo = (files: Record<string, string>) => ({
  files: Object.keys(files),
  read: (path: string) => files[path] ?? "",
  exists: (path: string) => path.replace(/^\/root\//, "") in files,
});

/* -------------------------------- extraction ------------------------------- */

test("every import form is found", () => {
  const found = importsIn(`
    import a from "./a";
    import { b } from '../b';
    import type { C } from "@/types/c";
    export { d } from "./d";
    export * from "./e";
    const f = require("./f");
    const g = await import("./g");
    import "./side-effect";
  `);
  eq(found.sort(), ["../b", "./a", "./d", "./e", "./f", "./g", "./side-effect", "@/types/c"]);
});

test("a multi-line import is still one import", () => {
  eq(importsIn(`import {\n  a,\n  b,\n} from "./thing";`), ["./thing"]);
});

test("a property access is not a require", () => {
  eq(importsIn(`obj.require("./no"); x.import("./no");`), []);
});

test("scanning is not order-dependent", () => {
  const source = `import a from "./a";\nimport b from "./b";`;
  eq(importsIn(source), importsIn(source), "a shared lastIndex would make the second call differ");
});

/* -------------------------------- resolution ------------------------------- */

test("a relative specifier resolves against the importing file", () => {
  const { exists } = repo({ "lib/b.ts": "" });
  eq(resolveSpecifier("/root", "lib/a.ts", "./b", exists), "lib/b.ts");
});

test("the @/ alias resolves against the project root", () => {
  const { exists } = repo({ "types/arch.ts": "" });
  eq(resolveSpecifier("/root", "app/deep/page.tsx", "@/types/arch", exists), "types/arch.ts");
});

test("a directory resolves through its index", () => {
  const { exists } = repo({ "lib/thing/index.ts": "" });
  eq(resolveSpecifier("/root", "app/x.ts", "../lib/thing", exists), "lib/thing/index.ts");
});

test("a package is not part of the architecture", () => {
  const { exists } = repo({ "lib/a.ts": "" });
  eq(resolveSpecifier("/root", "lib/a.ts", "react", exists), undefined);
  eq(resolveSpecifier("/root", "lib/a.ts", "node:fs", exists), undefined);
});

test("a specifier pointing at nothing resolves to nothing", () => {
  const { exists } = repo({ "lib/a.ts": "" });
  eq(resolveSpecifier("/root", "lib/a.ts", "./gone", exists), undefined);
});

/* ---------------------------------- graph ---------------------------------- */

const components = [
  component("ui", ["app/**"]),
  component("core", ["lib/**"]),
  component("tools", ["cli/**"]),
];

test("an import across a boundary is an edge", () => {
  const files = repo({
    "app/page.tsx": `import { thing } from "../lib/thing";`,
    "lib/thing.ts": "export const thing = 1;",
  });
  const edges = dependencyGraph("/root", components, files);
  eq(edges.length, 1);
  eq({ from: edges[0].from, to: edges[0].to, count: edges[0].count }, { from: "ui", to: "core", count: 1 });
});

test("an import inside one component is not an edge", () => {
  const files = repo({ "lib/a.ts": `import "./b";`, "lib/b.ts": "" });
  eq(dependencyGraph("/root", components, files), [], "a component depending on itself is just a component");
});

test("a file nobody owns is skipped rather than guessed at", () => {
  const files = repo({ "scripts/x.mjs": `import "../lib/a";`, "lib/a.ts": "" });
  eq(dependencyGraph("/root", components, files), []);
});

test("edges carry a count and a few examples, heaviest first", () => {
  const files = repo({
    "app/a.tsx": `import "../lib/x";`,
    "app/b.tsx": `import "../lib/x";`,
    "cli/c.ts": `import "../lib/x";`,
    "lib/x.ts": "",
  });
  const edges = dependencyGraph("/root", components, files);
  eq(edges.map((e) => `${e.from}->${e.to}:${e.count}`), ["ui->core:2", "tools->core:1"]);
  eq(edges[0].examples.length, 2);
});

/* ---------------------------------- drift ---------------------------------- */

const edge = (from: string, to: string, count = 1) => ({ from, to, count, examples: [] });

test("coupling the canvas does not draw is a finding", () => {
  const result = drift([], [edge("ui", "core", 9)]);
  eq(result.undeclared.map((e) => `${e.from}->${e.to}`), ["ui->core"]);
});

test("coupling the canvas does draw is not", () => {
  const result = drift([{ from: "ui", to: "core" }], [edge("ui", "core")]);
  eq(result.undeclared, []);
});

test("a declared edge is undirected, because a diagram's arrow usually is", () => {
  const result = drift([{ from: "core", to: "ui" }], [edge("ui", "core")]);
  eq(result.undeclared, [], "a backwards arrow reported as drift trains people to ignore this");
});

test("a declared relation with no import is reported apart, not as a violation", () => {
  const result = drift([{ from: "ui", to: "core" }], []);
  eq(result.undeclared, []);
  eq(result.unverifiable, [{ from: "ui", to: "core" }]);
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
