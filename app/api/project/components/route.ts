import { NextResponse } from "next/server";

import { catalogWarnings, componentTree } from "@/lib/project/component";
import { resolveRequestRoot } from "@/lib/project/request-root";
import { readComponents, readTasks, trackNode } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The catalog, with the counts the tree needs to be worth looking at.
 *
 * Open task counts are folded in here rather than fetched per component,
 * because the alternative is one request per node on a page whose whole job is
 * to show every node at once.
 */
export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ configured: false, components: [], tree: [], warnings: [] });
  }

  const components = readComponents(resolved.root);
  const tasks = readTasks(resolved.root).tasks;

  const counts = Object.fromEntries(
    components.map((c) => [
      c.id,
      {
        open: tasks.filter((t) => t.componentId === c.id && t.status !== "done").length,
        done: tasks.filter((t) => t.componentId === c.id && t.status === "done").length,
      },
    ]),
  );

  return NextResponse.json({
    configured: true,
    components,
    tree: componentTree(components),
    counts,
    warnings: catalogWarnings(components),
  });
};

/**
 * Makes a canvas node a component.
 *
 * The one write the browser needs that the CLI cannot stand in for -- somebody
 * looking at a diagram decides a box is real, and having to leave for a
 * terminal to say so is where the model would stop being used.
 */
export const POST = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as {
    diagramId?: string;
    nodeId?: string;
    title?: string;
    owner?: string;
    paths?: string[];
    parentId?: string;
  };

  if (!body.diagramId || !body.nodeId) {
    return NextResponse.json({ error: "diagramId and nodeId are required" }, { status: 400 });
  }

  const tracked = trackNode(resolved.root, body.diagramId, body.nodeId, {
    title: body.title,
    owner: body.owner,
    paths: body.paths,
    parentId: body.parentId,
  });

  if (!tracked) {
    return NextResponse.json(
      { error: `No node "${body.nodeId}" on diagram "${body.diagramId}"` },
      { status: 404 },
    );
  }
  return NextResponse.json(tracked, { status: 201 });
};
