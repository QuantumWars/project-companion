import { parentOf, trailTo, type DrilldownSource } from "@/lib/project/drilldown";
import { eq, ok, runAll, test } from "./harness";

/** A diagram with `label -> drilldownDiagramId` nodes; anything else is noise. */
const diagram = (
  id: string,
  title: string,
  links: Record<string, string | undefined>,
): DrilldownSource => ({
  id,
  title,
  nodes: Object.entries(links).map(([nodeId, target]) => ({
    id: nodeId,
    data: target ? { kind: "service", label: nodeId, drilldownDiagramId: target } : { kind: "note", label: nodeId },
  })),
});

test("the parent is whichever diagram points here", () => {
  const all = [
    diagram("context", "Context", { sys: "containers" }),
    diagram("containers", "Containers", {}),
  ];
  eq(parentOf("containers", all), { diagramId: "context", title: "Context", nodeId: "sys" });
});

test("a diagram nobody points at has no parent", () => {
  const all = [diagram("context", "Context", { note: undefined })];
  eq(parentOf("context", all), undefined);
});

test("a node pointing at its own diagram is not its own parent", () => {
  const all = [diagram("context", "Context", { self: "context" })];
  eq(parentOf("context", all), undefined);
});

test("the trail reads outermost first", () => {
  const all = [
    diagram("l1", "System context", { a: "l2" }),
    diagram("l2", "Containers", { b: "l3" }),
    diagram("l3", "Components", {}),
  ];
  eq(trailTo("l3", all).map((s) => s.diagramId), ["l1", "l2"]);
  eq(trailTo("l3", all).map((s) => s.title), ["System context", "Containers"]);
});

test("the top of the tree has an empty trail, so no breadcrumb is drawn", () => {
  const all = [diagram("l1", "System context", { a: "l2" }), diagram("l2", "Containers", {})];
  eq(trailTo("l1", all), []);
});

test("the node you came through is named, so the parent can highlight it", () => {
  const all = [diagram("l1", "Context", { gateway: "l2" }), diagram("l2", "Gateway", {})];
  eq(trailTo("l2", all)[0].nodeId, "gateway");
});

test("two diagrams pointing at each other do not hang the breadcrumb", () => {
  const all = [
    diagram("a", "A", { toB: "b" }),
    diagram("b", "B", { toA: "a" }),
  ];
  const trail = trailTo("b", all);
  ok(trail.length <= 2, "the walk is bounded rather than following the loop");
  eq(trail.map((s) => s.diagramId), ["a"]);
});

test("a longer cycle is truncated rather than followed", () => {
  const all = [
    diagram("a", "A", { x: "b" }),
    diagram("b", "B", { x: "c" }),
    diagram("c", "C", { x: "a" }),
  ];
  const trail = trailTo("c", all);
  ok(trail.length < 4, `bounded (got ${trail.length})`);
});

test("a diagram with no nodes at all is handled", () => {
  eq(trailTo("empty", [diagram("empty", "Empty", {})]), []);
});

test("nodes with unexpected data shapes are skipped, not thrown on", () => {
  const odd: DrilldownSource = {
    id: "weird",
    title: "Weird",
    nodes: [{ id: "n1", data: null }, { id: "n2", data: "not an object" }],
  };
  eq(parentOf("anything", [odd]), undefined);
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
