import { GitSurface } from "./_components/git-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GitPage = ({ searchParams }: { searchParams: { root?: string } }) => (
  <GitSurface root={searchParams.root} />
);

export default GitPage;
