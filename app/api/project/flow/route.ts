import { NextResponse } from "next/server";

import { dependencyGraph } from "@/lib/project/deps";
import { readEvents } from "@/lib/project/events";
import { attention, summarise, taskFlow } from "@/lib/project/flow";
import { resolveRequestRoot } from "@/lib/project/request-root";
import { readComponents, readTasks } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Flow, and what to look at first.
 *
 * Both from one request because they are computed from the same fold: asking
 * for them separately would walk the log twice to answer one question.
 */
export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) return NextResponse.json({ configured: false });

  const tasks = readTasks(resolved.root).tasks;
  const flows = taskFlow(readEvents(resolved.root), tasks);
  const components = readComponents(resolved.root);

  // Fan-in is what turns age into blast radius. It needs the dependency graph,
  // which is a full source walk -- acceptable here because this is one request
  // for a page somebody opened, not something on a write path.
  const fanIn: Record<string, number> = {};
  for (const edge of dependencyGraph(resolved.root, components)) {
    fanIn[edge.to] = (fanIn[edge.to] ?? 0) + 1;
  }

  const componentOf = Object.fromEntries(
    tasks.filter((t) => t.componentId).map((t) => [t.id, t.componentId!]),
  );
  const titles = Object.fromEntries(tasks.map((t) => [t.id, t.title]));

  return NextResponse.json({
    configured: true,
    summary: summarise(flows),
    attention: attention(flows, { fanIn, componentOf })
      .slice(0, 8)
      .map((item) => ({ ...item, title: titles[item.taskId] ?? item.taskId, componentId: componentOf[item.taskId] })),
  });
};
