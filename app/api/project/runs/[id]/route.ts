import { NextResponse } from "next/server";

import { resolveRequestRoot } from "@/lib/project/request-root";
import { RUN_STATES, type RunState } from "@/lib/project/run";
import { setRunState } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The human half of a run's lifecycle.
 *
 * Approving, sending to review, merging and abandoning are decisions, and this
 * is where a person makes them. The state machine is enforced in the store, so
 * an impossible transition comes back as a 409 with the reason rather than
 * being quietly ignored -- the button was wrong, and saying so is the point.
 */
export const PATCH = async (request: Request, { params }: { params: { id: string } }) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const body = (await request.json()) as { state?: string; reason?: string };
  if (!body.state || !(RUN_STATES as readonly string[]).includes(body.state)) {
    return NextResponse.json({ error: `Unknown state "${body.state}"` }, { status: 400 });
  }

  try {
    const run = setRunState(resolved.root, params.id, body.state as RunState, body.reason);
    if (!run) return NextResponse.json({ error: `No run "${params.id}"` }, { status: 404 });
    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
};
