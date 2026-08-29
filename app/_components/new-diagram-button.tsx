"use client";

import { Plus } from "lucide-react";

import { NewDiagram } from "@/app/project/(surfaces)/_components/new-diagram";

/**
 * The project-scoped create action on the launcher.
 *
 * Distinct from the scratch actions beneath it, and deliberately so: a diagram
 * made here is a file in the repository that a coding agent can read, while a
 * scratch board lives in this browser and is invisible to it. Presenting both
 * as the same kind of "new" is how someone ends up with work the agent will
 * never see.
 */
export const NewDiagramButton = ({
  root,
  projectName,
}: {
  root: string | null;
  projectName: string;
}) => (
  <div>
    <p className="mb-1.5 text-2xs text-fg-subtle">In {projectName}</p>
    <div className="flex items-center gap-x-2 rounded-lg bg-bg-subtle px-2 py-1.5">
      <Plus className="h-3.5 w-3.5 shrink-0 text-brand" />
      <span className="flex-1 text-[13px] text-fg">New diagram</span>
      <NewDiagram root={root} align="right" />
    </div>
  </div>
);
