import { NextResponse } from "next/server";

import { findProjectRoot } from "@/lib/project/store";
import { listProjects, registerProject } from "@/lib/project/registry";
import { summariseProject } from "@/lib/project/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every project this machine knows about, plus which one the app runs inside.
 *
 * Summaries are computed in parallel because each one touches the filesystem
 * and may shell out to git; done in sequence, a machine with a dozen projects
 * would visibly stall the launcher.
 */
export const GET = async () => {
  // Serving the app from a repository is itself a reason to index it.
  const here = findProjectRoot();
  if (here) registerProject(here);

  const projects = await Promise.all(
    listProjects().map((p) =>
      summariseProject(p.path, {
        name: p.name,
        storeDir: p.storeDir,
        lastOpened: p.lastOpened,
      }),
    ),
  );

  return NextResponse.json({ current: here, projects });
};
