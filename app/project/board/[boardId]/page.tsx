import { Room } from "@/components/room";
import { Canvas } from "@/app/board/[boardId]/_components/canvas";
import { Loading } from "@/app/board/[boardId]/_components/loading";

interface ProjectBoardPageProps {
  params: { boardId: string };
  /** `?root=` opens a board in another indexed project. */
  searchParams: { root?: string };
}

/**
 * The file-backed whiteboard.
 *
 * Same canvas as `/board/[boardId]`, but its layers live in the project store
 * rather than localStorage -- so a coding agent can read a whiteboard, and a
 * whiteboard is committed and reviewed like the rest of the project.
 */
const ProjectBoardPage = ({
  params,
  searchParams,
}: ProjectBoardPageProps) => (
  <Room
    roomId={params.boardId}
    source="file"
    root={searchParams.root}
    fallback={<Loading />}
  >
    <Canvas boardId={params.boardId} source="file" />
  </Room>
);

export default ProjectBoardPage;
