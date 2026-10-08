import { notFound } from "next/navigation";

import { componentContext } from "@/lib/project/component-context";
import { isKnownProject } from "@/lib/project/registry";
import { findProjectRoot } from "@/lib/project/store";
import { ComponentWorkspace } from "./_components/workspace";

interface Props {
  params: { componentId: string };
  searchParams: { root?: string; tab?: string };
}

/**
 * One part of the system, and everything happening inside it.
 *
 * The surface the whole component model exists for. Until this page a component
 * was something the CLI could describe and the browser could not show, so the
 * architecture was still a picture beside the work rather than the way into it.
 *
 * Rendered on the server because the assembly reads the roadmap and the
 * repository, and doing it here means the page arrives complete rather than
 * flashing four empty tabs while it fetches. The client half only handles
 * switching between them.
 */
const ComponentPage = async ({ params, searchParams }: Props) => {
  const root =
    searchParams.root && isKnownProject(searchParams.root)
      ? searchParams.root
      : findProjectRoot();

  if (!root) notFound();

  const context = await componentContext(root, { componentId: params.componentId });
  if (!context.found) notFound();

  return (
    <ComponentWorkspace
      context={context}
      root={searchParams.root}
      initialTab={searchParams.tab}
    />
  );
};

export default ComponentPage;
