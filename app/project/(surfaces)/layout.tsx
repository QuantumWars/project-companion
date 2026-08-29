import { notFound } from "next/navigation";

import { isKnownProject } from "@/lib/project/registry";
import { findProjectRoot, readProject } from "@/lib/project/store";

import { ProjectNav } from "./_components/project-nav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wraps the project's document surfaces -- overview, roadmap, board, git.
 *
 * Deliberately a route group, so the two full-screen canvases
 * (`/project/diagram/<id>` and `/project/board/<id>`) sit outside it and keep
 * the whole viewport.
 *
 * A layout cannot read `searchParams` in the app router, so `?root=` is
 * resolved the same way here as in the API and re-read client-side by the nav.
 */
const SurfacesLayout = ({ children }: { children: React.ReactNode }) => {
  const root = findProjectRoot();
  if (!root) notFound();

  const project = readProject(root);

  return (
    <div className="h-full bg-bg">
      <ProjectNav name={project.name} diagrams={project.diagrams}>
        {children}
      </ProjectNav>
    </div>
  );
};

export default SurfacesLayout;
