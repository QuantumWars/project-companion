import { notFound } from "next/navigation";

import { isKnownProject } from "@/lib/project/registry";
import { findProjectRoot, listDiagrams } from "@/lib/project/store";

import { Overview } from "./_components/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OverviewPage = ({ searchParams }: { searchParams: { root?: string } }) => {
  const asked = searchParams.root;
  const root = asked && isKnownProject(asked) ? asked : findProjectRoot();
  if (!root) notFound();

  return <Overview root={asked} diagrams={listDiagrams(root)} />;
};

export default OverviewPage;
