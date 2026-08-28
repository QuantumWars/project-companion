import { NextResponse } from "next/server";

import { findProjectRoot } from "@/lib/project/store";
import { listProjects, registerProject } from "@/lib/project/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every project this machine knows about, plus which one the app runs inside. */
export const GET = async () => {
  // Serving the app from a repository is itself a reason to index it.
  const here = findProjectRoot();
  if (here) registerProject(here);

  return NextResponse.json({ current: here, projects: listProjects() });
};
