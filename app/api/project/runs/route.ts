import { NextResponse } from "next/server";

import { resolveRequestRoot } from "@/lib/project/request-root";
import { checkBudget } from "@/lib/project/run";
import { readRuns } from "@/lib/project/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every run, with the one derived fact the surface cannot compute for itself.
 *
 * `checkBudget` lives beside the run rules rather than in the component, so it
 * is evaluated here: a browser reimplementing "is this over budget" would drift
 * from the version the agent is actually held to, and the two disagreeing about
 * whether a run may continue is the worst possible bug in this area.
 */
export const GET = async (request: Request) => {
  const resolved = resolveRequestRoot(request);
  if (!resolved.ok) return NextResponse.json({ configured: false, runs: [] });

  const runs = readRuns(resolved.root).map((run) => ({
    ...run,
    budgetVerdict: checkBudget(run),
  }));

  return NextResponse.json({ configured: true, runs });
};
