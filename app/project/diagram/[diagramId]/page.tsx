import { ArchCanvas } from "@/app/arch/[boardId]/_components/arch-canvas";
import { trailTo } from "@/lib/project/drilldown";
import { isKnownProject } from "@/lib/project/registry";
import { findProjectRoot, listDiagrams, readDiagram } from "@/lib/project/store";
import { DrilldownTrail } from "./_components/drilldown-trail";

interface ProjectDiagramPageProps {
  params: { diagramId: string };
  /** `?root=` opens a diagram in another indexed project. */
  searchParams: { root?: string };
}

/**
 * The file-backed canvas.
 *
 * Same canvas as `/arch/[boardId]`, but reading and writing `.project` through
 * the local API instead of localStorage -- so what an agent writes shows up
 * here, and what is edited here is what the agent reads back.
 *
 * The drill-down trail is computed here rather than in the canvas because it
 * needs every diagram's nodes to find which one points at this one, and that is
 * a filesystem read. Sending it down as a prop keeps the canvas from having to
 * fetch the whole project to draw a breadcrumb.
 */
const ProjectDiagramPage = ({ params, searchParams }: ProjectDiagramPageProps) => {
  const root =
    searchParams.root && isKnownProject(searchParams.root)
      ? searchParams.root
      : findProjectRoot();

  const trail = root ? buildTrail(root, params.diagramId) : null;

  return (
    <>
      {trail ? (
        <DrilldownTrail trail={trail.steps} title={trail.title} root={searchParams.root} />
      ) : null}
      <ArchCanvas boardId={params.diagramId} source="file" root={searchParams.root} />
    </>
  );
};

/**
 * Reads every diagram once to find the way back up.
 *
 * Degrades to no breadcrumb rather than failing the page: a diagram that cannot
 * be read is a diagram the canvas will report on its own, and a missing trail is
 * a much smaller problem than a blank screen.
 */
const buildTrail = (root: string, diagramId: string) => {
  try {
    const current = readDiagram(root, diagramId);
    if (!current) return null;

    const all = listDiagrams(root)
      .filter((ref) => (ref.kind ?? "diagram") === "diagram")
      .map((ref) => readDiagram(root, ref.id))
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map((d) => ({ id: d.id, title: d.title, nodes: d.nodes }));

    const steps = trailTo(diagramId, all);
    return steps.length ? { steps, title: current.title } : null;
  } catch {
    return null;
  }
};

export default ProjectDiagramPage;
