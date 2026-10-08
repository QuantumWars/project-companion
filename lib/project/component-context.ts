/**
 * Everything about one component, assembled once.
 *
 * The MCP server and the web app both need this, and they need it to agree:
 * an agent that reads a component's criteria and a person looking at the same
 * component's page must see the same thing, or one of them is working from a
 * picture that is subtly wrong. So the gathering lives here and both call it,
 * for the same reason the CLI and the MCP server share `store.ts`.
 *
 * The expensive part is deliberate. Resolving which features and commits belong
 * to a component means walking the roadmap and the repository, and doing it
 * server-side costs an agent no context at all -- which is the whole argument
 * for a local tool doing retrieval rather than asking a model to.
 */

import { catalogWarnings, componentChurn, ancestorsOf, resolveComponent, withDescendants, type Component } from "./component";
import { readEvents, type ProjectEvent } from "./events";
import type { StoredFinding } from "./review";
import { readGitView } from "./git-view";
import { readRoadmap } from "./roadmap";
import { readComponents, readFindings, readTasks, resolvePolicy } from "./store";
import type { AcceptanceCriterion, Task } from "./types";

export type ComponentSpec = {
  id: string;
  title: string;
  status: string;
  criteria: AcceptanceCriterion[];
};

export type ComponentEvidence = {
  commits: { sha: string; subject: string; author: string; at: string; signal: string | null; insertions: number; deletions: number }[];
  total: number;
  contributors: string[];
  insertions: number;
  deletions: number;
};

export type ComponentContext = {
  found: boolean;
  reason?: string;
  component?: Component & { ancestors: string[]; children: string[] };
  spec: ComponentSpec[];
  tasks: Task[];
  evidence: ComponentEvidence | null;
  /** What agents may do here, after the project default and this component's own. */
  policy: ReturnType<typeof resolvePolicy>;
  /** Open review findings against this component, worst first. */
  findings: StoredFinding[];
  recent: ProjectEvent[];
  warnings: string[];
};

const NOT_FOUND = (reason: string): ComponentContext => ({
  found: false,
  reason,
  spec: [],
  tasks: [],
  evidence: null,
  policy: { autonomy: "confirm" },
  findings: [],
  recent: [],
  warnings: [],
});

/**
 * The features this component is responsible for.
 *
 * A feature declares `Paths:` and so does a component, so the link is the glob
 * they share: a feature belongs here when the region it names resolves to this
 * component. The literal prefix of the glob is what gets resolved -- `lib/auth/**`
 * is asked about as `lib/auth/`, because a wildcard is not a path and asking
 * `resolveComponent` about one would match nothing.
 *
 * A feature explicitly linked to this component's canvas node counts too. That
 * is a claim somebody made, and a claim outranks a path inference here exactly
 * as it does in commit attribution.
 */
const specFor = (
  component: Component,
  components: readonly Component[],
  features: readonly { id: string; title: string; status: string; paths?: string[]; nodeIds?: string[]; acceptance: AcceptanceCriterion[] }[],
): ComponentSpec[] =>
  features
    .filter((feature) => {
      if (component.nodeId && (feature.nodeIds ?? []).includes(component.nodeId)) return true;
      return (feature.paths ?? []).some((glob) => {
        const literal = glob.replace(/[*?].*$/, "");
        if (!literal) return false;
        return resolveComponent(literal, components)?.componentId === component.id;
      });
    })
    .map((f) => ({ id: f.id, title: f.title, status: f.status, criteria: f.acceptance }));

export const componentContext = async (
  root: string,
  options: { componentId?: string; path?: string; includeEvidence?: boolean },
): Promise<ComponentContext> => {
  const components = readComponents(root);

  const id =
    options.componentId ??
    (options.path ? resolveComponent(options.path, components)?.componentId : undefined);

  if (!id) {
    return NOT_FOUND(
      options.path
        ? `No component owns ${options.path}. Either nothing claims it, or two ` +
          `things claim it equally well -- in which case neither is attributed, ` +
          `deliberately.`
        : "Give a componentId or a path.",
    );
  }

  const component = components.find((c) => c.id === id);
  if (!component) return NOT_FOUND(`No component "${id}".`);

  // A component's board is its own work plus its children's: that is what
  // "everything happening inside this part of the system" means.
  const family = withDescendants(id, components);
  const roadmap = readRoadmap(root);
  const tasks = readTasks(root).tasks.filter((t) => family.includes(t.componentId ?? ""));

  let evidence: ComponentEvidence | null = null;
  if (options.includeEvidence !== false) {
    const view = await readGitView(root, roadmap.features, { limit: 150 });
    const matched = (view.attribution?.commits ?? [])
      .map((commit) => ({
        commit,
        churn: componentChurn(commit.files, components).find((c) => c.componentId === id),
      }))
      .filter((m): m is { commit: (typeof m)["commit"]; churn: NonNullable<(typeof m)["churn"]> } =>
        Boolean(m.churn),
      );

    evidence = {
      commits: matched.slice(0, 30).map(({ commit, churn }) => ({
        sha: commit.short,
        subject: commit.subject,
        author: commit.author,
        at: commit.at,
        signal: commit.signal ?? null,
        insertions: churn.insertions,
        deletions: churn.deletions,
      })),
      total: matched.length,
      contributors: Array.from(new Set(matched.map((m) => m.commit.author))),
      insertions: matched.reduce((n, m) => n + m.churn.insertions, 0),
      deletions: matched.reduce((n, m) => n + m.churn.deletions, 0),
    };
  }

  return {
    found: true,
    component: {
      ...component,
      ancestors: ancestorsOf(id, components).map((c) => c.id),
      children: components.filter((c) => c.parentId === id).map((c) => c.id),
    },
    spec: specFor(component, components, roadmap.features),
    policy: resolvePolicy(root, id),
    findings: readFindings(root).filter((f) => f.componentId === id),
    tasks,
    evidence,
    recent: readEvents(root)
      .filter((e) => e.componentId === id)
      .slice(-20)
      .reverse(),
    warnings: catalogWarnings(components)
      .filter((w) => w.componentId === id)
      .map((w) => w.detail),
  };
};
