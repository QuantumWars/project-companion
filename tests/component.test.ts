import {
  ancestorsOf, catalogWarnings, componentChurn, componentId, componentTree,
  resolveComponent, specificity, withDescendants, type Component,
} from "@/lib/project/component";
import { eq, ok, runAll, test } from "./harness";

/** Fixed dates so assertions do not move with the clock. */
const component = (over: Partial<Component> & { id: string }): Component => ({
  title: over.id,
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/* --------------------------------- identity -------------------------------- */

test("component ids are readable and collision-checked", () => {
  eq(componentId("Auth Service", []), "auth-service");
  eq(componentId("  Billing / Invoices  ", []), "billing-invoices");

  const second = componentId("Auth Service", ["auth-service"]);
  ok(second.startsWith("auth-service-"), "a taken id gets a suffix");
  ok(second !== "auth-service");
});

test("a title with nothing sluggable still gets an id", () => {
  const id = componentId("...", []);
  ok(id.length >= 8, "falls back to a random id rather than an empty string");
});

/* -------------------------------- resolution ------------------------------- */

test("specificity ranks a longer literal prefix first", () => {
  const deep = specificity("lib/auth/**");
  const shallow = specificity("lib/**");
  ok(deep[0] > shallow[0], "lib/auth/ is a narrower claim than lib/");
});

test("an exact file beats the directory that contains it", () => {
  const components = [
    component({ id: "platform", paths: ["lib/**"] }),
    component({ id: "auth", paths: ["lib/auth/**"] }),
    component({ id: "tokens", paths: ["lib/auth/token.ts"] }),
  ];

  eq(resolveComponent("lib/auth/token.ts", components)?.componentId, "tokens");
  eq(resolveComponent("lib/auth/session.ts", components)?.componentId, "auth");
  eq(resolveComponent("lib/util.ts", components)?.componentId, "platform");
});

test("the winning glob comes back, so attribution can be explained", () => {
  const components = [component({ id: "auth", paths: ["lib/auth/**", "app/login/**"] })];
  eq(resolveComponent("lib/auth/token.ts", components)?.glob, "lib/auth/**");
  eq(resolveComponent("app/login/page.tsx", components)?.glob, "app/login/**");
});

test("an ambiguous match is no match", () => {
  const components = [
    component({ id: "auth", paths: ["lib/shared/**"] }),
    component({ id: "billing", paths: ["lib/shared/**"] }),
  ];
  eq(resolveComponent("lib/shared/money.ts", components), undefined);
});

test("a file nobody claims resolves to nothing rather than a guess", () => {
  const components = [component({ id: "auth", paths: ["lib/auth/**"] })];
  eq(resolveComponent("scripts/build.mjs", components), undefined);
});

test("a component with no paths never attributes anything", () => {
  const components = [component({ id: "ideas" }), component({ id: "auth", paths: ["lib/**"] })];
  eq(resolveComponent("lib/auth/token.ts", components)?.componentId, "auth");
});

test("`**` crossing directories loses to a `*` that does not", () => {
  const components = [
    component({ id: "broad", paths: ["app/**/route.ts"] }),
    component({ id: "narrow", paths: ["app/api/*.ts"] }),
  ];
  eq(resolveComponent("app/api/thing.ts", components)?.componentId, "narrow");
});

/* ---------------------------------- churn ---------------------------------- */

test("churn is counted per component, and a change can touch several", () => {
  const components = [
    component({ id: "auth", paths: ["lib/auth/**"] }),
    component({ id: "ui", paths: ["app/**"] }),
  ];

  const churn = componentChurn(
    [
      { path: "lib/auth/token.ts", insertions: 30, deletions: 4 },
      { path: "lib/auth/session.ts", insertions: 10, deletions: 0 },
      { path: "app/login/page.tsx", insertions: 5, deletions: 1 },
      { path: "README.md", insertions: 2, deletions: 2 },
    ],
    components,
  );

  eq(churn, [
    { componentId: "auth", insertions: 40, deletions: 4, files: 2 },
    { componentId: "ui", insertions: 5, deletions: 1, files: 1 },
  ]);
});

test("churn on an ambiguous file is attributed to nobody, not to both", () => {
  const components = [
    component({ id: "a", paths: ["lib/shared/**"] }),
    component({ id: "b", paths: ["lib/shared/**"] }),
  ];
  eq(componentChurn([{ path: "lib/shared/x.ts", insertions: 9, deletions: 9 }], components), []);
});

/* ----------------------------------- tree ---------------------------------- */

test("the containment tree assembles, sorted and nested", () => {
  const components = [
    component({ id: "api", title: "API", parentId: "platform" }),
    component({ id: "platform", title: "Platform" }),
    component({ id: "db", title: "Database", parentId: "platform" }),
    component({ id: "web", title: "Web" }),
  ];

  const tree = componentTree(components);
  eq(tree.map((n) => n.id), ["platform", "web"]);
  eq(tree[0].children.map((n) => n.id), ["api", "db"], "children sort by title");
});

test("a dangling parent leaves the component at the root, not missing", () => {
  const components = [component({ id: "api", parentId: "gone" })];
  eq(componentTree(components).map((n) => n.id), ["api"]);
});

test("a parent cycle does not hang the tree or the ancestry", () => {
  const components = [
    component({ id: "a", parentId: "b" }),
    component({ id: "b", parentId: "a" }),
  ];
  ok(componentTree(components).length >= 1, "a cycle still produces a tree");
  eq(ancestorsOf("a", components).map((c) => c.id), ["b"]);
});

test("descendants roll a parent's board up from its children", () => {
  const components = [
    component({ id: "platform" }),
    component({ id: "api", parentId: "platform" }),
    component({ id: "handlers", parentId: "api" }),
    component({ id: "web" }),
  ];
  eq(withDescendants("platform", components), ["platform", "api", "handlers"]);
  eq(withDescendants("web", components), ["web"]);
});

test("ancestry reads root first, for a breadcrumb", () => {
  const components = [
    component({ id: "platform" }),
    component({ id: "api", parentId: "platform" }),
    component({ id: "handlers", parentId: "api" }),
  ];
  eq(ancestorsOf("handlers", components).map((c) => c.id), ["platform", "api"]);
});

/* --------------------------------- hygiene --------------------------------- */

test("an unowned component with no paths is reported, because it looks like coverage", () => {
  const warnings = catalogWarnings([component({ id: "ghost" })]);
  eq(warnings.map((w) => w.kind).sort(), ["no-paths", "unowned"]);
});

test("a healthy component produces no warnings", () => {
  const warnings = catalogWarnings([
    component({ id: "auth", owner: "grace@example.com", paths: ["lib/auth/**"] }),
  ]);
  eq(warnings, []);
});

test("two components claiming the same glob are both told about it", () => {
  const warnings = catalogWarnings([
    component({ id: "a", owner: "x", paths: ["lib/shared/**"] }),
    component({ id: "b", owner: "y", paths: ["lib/shared/**"] }),
  ]);
  const ambiguous = warnings.filter((w) => w.kind === "ambiguous-paths");
  eq(ambiguous.map((w) => w.componentId).sort(), ["a", "b"]);
  ok(ambiguous[0].detail.includes("b"), "the warning names the other claimant");
});

test("an orphan is reported once, without piling on its other problems", () => {
  const warnings = catalogWarnings([component({ id: "gone", orphaned: true })]);
  eq(warnings.map((w) => w.kind), ["orphaned"]);
});

test("a dangling parent is a catalog problem, and says so", () => {
  const warnings = catalogWarnings([
    component({ id: "api", owner: "x", paths: ["app/**"], parentId: "missing" }),
  ]);
  eq(warnings.map((w) => w.kind), ["dangling-parent"]);
  ok(warnings[0].detail.includes("missing"));
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
