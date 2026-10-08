import { NextResponse } from "next/server";

import { readCockpit } from "@/lib/project/cockpit";
import { resolveRequestRoot } from "@/lib/project/request-root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The PM cockpit model (devolps PC-01..PC-11).
 *
 * GET only, on purpose: the cockpit is read-only (devolps decision Q4). Every
 * decision is a command the PM types in Claude Code, which is the one channel
 * Claude Code itself proves came from a person.
 */
export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  return NextResponse.json(readCockpit(resolved.root));
};
