import { notFound } from "next/navigation";

import { isKnownProject } from "@/lib/project/registry";
import { findProjectRoot, listDiagrams, readDiagram } from "@/lib/project/store";

import { Board } from "./_components/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chrome that used to live here now comes from the surfaces layout, so this
 * page only prepares data the browser would otherwise have to assemble by
 * fetching every diagram: a card labels its architecture-node chips from this.
 */
const TasksPage = ({ searchParams }: { searchParams: { root?: string } }) => {
  const asked = searchParams.root;
  const root = asked && isKnownProject(asked) ? asked : findProjectRoot();
  if (!root) notFound();

  const nodeLookup: Record<string, { label: string; diagramId: string }> = {};
  for (const ref of listDiagrams(root)) {
    if (ref.kind === "whiteboard") continue;
    const diagram = readDiagram(root, ref.id);
    for (const node of diagram?.nodes ?? []) {
      const label = (node.data as { label?: string })?.label;
      if (label) nodeLookup[node.id] = { label, diagramId: ref.id };
    }
  }

  return <Board nodeLookup={nodeLookup} root={asked} />;
};

export default TasksPage;
