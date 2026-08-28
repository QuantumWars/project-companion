import { ArchCanvas } from "@/app/arch/[boardId]/_components/arch-canvas";

interface ProjectDiagramPageProps {
  params: { diagramId: string };
  /** `?root=` opens a diagram in another indexed project. */
  searchParams: { root?: string };
}

/**
 * The file-backed canvas.
 *
 * Same canvas as `/arch/[boardId]`, but reading and writing `.arch/` through
 * the local API instead of localStorage -- so what an agent writes shows up
 * here, and what is edited here is what the agent reads back.
 */
const ProjectDiagramPage = ({
  params,
  searchParams,
}: ProjectDiagramPageProps) => (
  <ArchCanvas
    boardId={params.diagramId}
    source="file"
    root={searchParams.root}
  />
);

export default ProjectDiagramPage;
