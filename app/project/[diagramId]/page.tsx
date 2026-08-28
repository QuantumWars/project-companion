import { redirect } from "next/navigation";

/**
 * The canvas moved to `/project/diagram/<id>` so that surfaces like
 * `/project/roadmap` and `/project/git` are static segments rather than
 * competing with this dynamic one -- a diagram whose slug happened to be
 * "roadmap" would otherwise have been permanently unreachable.
 *
 * Old links keep working.
 */
const LegacyDiagramRoute = ({
  params,
  searchParams,
}: {
  params: { diagramId: string };
  searchParams: { root?: string };
}) => {
  const query = searchParams.root ? `?root=${encodeURIComponent(searchParams.root)}` : "";
  redirect(`/project/diagram/${params.diagramId}${query}`);
};

export default LegacyDiagramRoute;
