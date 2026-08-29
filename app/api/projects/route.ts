import { NextResponse } from "next/server";

import { findProjectRoot } from "@/lib/project/store";
import { forgetProject, isKnownProject, listProjects, registerProject } from "@/lib/project/registry";
import { deleteProject } from "@/lib/project/store";
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

/**
 * Removes a project.
 *
 * `?data=1` deletes the store from disk; without it only the index entry goes,
 * which is the reversible option and therefore the default. The path must
 * already be indexed -- the same allowlist that gates reading gates this, so a
 * crafted request cannot point the delete at an arbitrary directory.
 */
export const DELETE = async (request: Request) => {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  if (!isKnownProject(path)) {
    return NextResponse.json(
      { error: "Unknown project. Only indexed projects can be removed." },
      { status: 403 },
    );
  }

  if (url.searchParams.get("data") === "1") {
    const summary = deleteProject(path);
    if (!summary) {
      return NextResponse.json({ error: "No project store found there." }, { status: 404 });
    }
    forgetProject(path);
    return NextResponse.json({ ok: true, deleted: summary });
  }

  return NextResponse.json({ ok: true, forgotten: forgetProject(path) });
};
