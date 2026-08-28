import { RoadmapView } from "./_components/roadmap-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RoadmapPage = ({ searchParams }: { searchParams: { root?: string } }) => (
  <RoadmapView root={searchParams.root} />
);

export default RoadmapPage;
