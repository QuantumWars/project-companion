import { NextResponse } from "next/server";

import { COMPONENT_LIFECYCLES } from "@/lib/project/component";
import { componentContext } from "@/lib/project/component-context";
import { resolveRequestRoot } from "@/lib/project/request-root";
import { setAgentPolicy, updateComponent, untrackNode } from "@/lib/project/store";
import { AUTONOMY_LEVELS, type AgentPolicy } from "@/lib/project/bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: { id: string };
}

/**
 * Everything about one component.
 *
 * The same assembly the MCP tool returns, from the same function, so an agent
 * and a person are never looking at two different versions of the truth.
 * `?evidence=0` skips the repository read for callers that only need the board.
 */
export const GET = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ found: false, reason: resolved.error }, { status: resolved.status });
  }

  const url = new URL(request.url);
  const context = await componentContext(resolved.root, {
    componentId: params.id,
    includeEvidence: url.searchParams.get("evidence") !== "0",
  });

  return NextResponse.json(context, { status: context.found ? 200 : 404 });
};

export const PATCH = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as {
    title?: string;
    owner?: string;
    paths?: string[];
    parentId?: string;
    lifecycle?: string;
    agentPolicy?: AgentPolicy | null;
  };

  if (
    body.agentPolicy?.autonomy &&
    !(AUTONOMY_LEVELS as readonly string[]).includes(body.agentPolicy.autonomy)
  ) {
    return NextResponse.json(
      { error: `Unknown autonomy "${body.agentPolicy.autonomy}"` },
      { status: 400 },
    );
  }
  if (body.agentPolicy !== undefined) setAgentPolicy(resolved.root, params.id, body.agentPolicy);

  if (body.lifecycle && !COMPONENT_LIFECYCLES.includes(body.lifecycle as never)) {
    return NextResponse.json(
      { error: `Unknown lifecycle "${body.lifecycle}"` },
      { status: 400 },
    );
  }

  const { agentPolicy, ...patch } = body;
  const updated = updateComponent(resolved.root, params.id, patch as never);
  if (!updated) return NextResponse.json({ error: `No component "${params.id}"` }, { status: 404 });
  return NextResponse.json(updated);
};

/**
 * Stops treating the node as a component, without discarding what it owns.
 *
 * Never a hard delete from here. The browser is where somebody clicks the wrong
 * thing, and orphaning is recoverable in a way that losing every task and commit
 * attributed to a component is not.
 */
export const DELETE = async (request: Request, { params }: Params) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const untracked = untrackNode(resolved.root, params.id);
  if (!untracked) return NextResponse.json({ error: `No component "${params.id}"` }, { status: 404 });
  return NextResponse.json(untracked);
};
