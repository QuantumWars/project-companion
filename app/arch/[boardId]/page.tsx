import { ArchCanvas } from "./_components/arch-canvas";

interface ArchBoardPageProps {
  params: {
    boardId: string;
  };
}

const ArchBoardPage = ({ params }: ArchBoardPageProps) => (
  <ArchCanvas boardId={params.boardId} />
);

export default ArchBoardPage;
