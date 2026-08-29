/**
 * Lane assignment for a commit DAG.
 *
 * The familiar railway diagram. Two properties separate a graph that is
 * pleasant to read from one that is not, and both come from Pierre Vigier's
 * survey of how the major clients do it
 * (pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html):
 *
 *   1. STRAIGHT BRANCHES. A branch should occupy one column for its whole
 *      life. Most clients fail at this and draw visible zig-zags; GitKraken is
 *      the notable exception. It is achieved by letting a commit inherit the
 *      lane of the child that continues its branch, rather than claiming any
 *      free lane.
 *
 *   2. NO EDGE-OVER-COMMIT CROSSINGS. A merge edge that has to travel several
 *      rows must not be routed through a column another commit is sitting in.
 *      That means tracking, per lane, the rows it is already spoken for.
 *
 * The first-parent convention is what makes (1) expressible at all: a child
 * whose `parents[0]` is this commit CONTINUES this branch, so it hands its lane
 * down. Any other child is a merge, and its edge has to find a free route.
 *
 * Input is assumed to already be in `git log` order, which is reverse
 * chronological with topological constraints -- newest first.
 */

export type GraphEdge = {
  /** Lane the edge leaves from, at the child's row. */
  fromLane: number;
  /** Lane the edge arrives in, at the parent's row. */
  toLane: number;
  /** Row index of the parent, so the renderer knows how far the edge travels. */
  toRow: number;
  /** A merge edge is a second-or-later parent and is drawn differently. */
  isMerge: boolean;
};

export type GraphRow<T extends { sha: string; parents: string[] }> = {
  commit: T;
  lane: number;
  /** Lanes with a line passing through this row, for the vertical rails. */
  active: number[];
  /** Edges leaving this commit downward toward its parents. */
  edges: GraphEdge[];
};

export type CommitGraph<T extends { sha: string; parents: string[] }> = {
  rows: GraphRow<T>[];
  width: number;
};

type Reservation = { lane: number; untilRow: number };

export const buildGraph = <T extends { sha: string; parents: string[] }>(
  commits: T[],
): CommitGraph<T> => {
  const rowOf = new Map<string, number>();
  commits.forEach((commit, index) => rowOf.set(commit.sha, index));

  /**
   * The trunk: the first-parent chain walked back from the newest commit.
   *
   * Pinning it to lane 0 is the third property that separates a readable
   * diagram from a merely correct one. Without it the trunk drifts sideways at
   * every merge, because a feature branch cut from the same commit can claim
   * that commit as ITS first parent and take the lane first. Git itself treats
   * the first-parent chain as "the branch", which is what `--first-parent`
   * means, so following it here matches what people already expect.
   */
  const trunk = new Set<string>();
  if (commits.length) {
    let cursor: T | undefined = commits[0];
    while (cursor !== undefined && !trunk.has(cursor.sha)) {
      trunk.add(cursor.sha);
      const next: string | undefined = cursor.parents[0];
      const nextRow: number | undefined = next === undefined ? undefined : rowOf.get(next);
      cursor = nextRow === undefined ? undefined : commits[nextRow];
    }
  }

  /**
   * Which child continues each commit's branch.
   *
   * A commit's branch child is the child that named it as `parents[0]`. When
   * several do -- possible after a rebase or an octopus merge -- the nearest
   * one wins, because that is the one whose lane is still open.
   */
  const branchChild = new Map<string, string>();
  for (const commit of commits) {
    const firstParent = commit.parents[0];
    if (!firstParent) continue;
    const existing = branchChild.get(firstParent);
    if (existing === undefined || rowOf.get(commit.sha)! < rowOf.get(existing)!) {
      branchChild.set(firstParent, commit.sha);
    }
  }

  // lanes[i] holds the sha that lane i is currently reserved for, or null.
  const lanes: (string | null)[] = [];
  // Rows each lane is already committed to spanning, so a later edge does not
  // route through a commit that is sitting there.
  const reserved: Reservation[] = [];
  const rows: GraphRow<T>[] = [];
  const laneOf = new Map<string, number>();
  let width = 0;

  const isBlocked = (lane: number, fromRow: number, toRow: number): boolean =>
    reserved.some(
      (r) => r.lane === lane && r.untilRow > fromRow && r.untilRow <= toRow,
    );

  const freeLane = (fromRow: number, toRow: number): number => {
    // Lane 0 belongs to the trunk; a side branch starts looking at 1.
    for (let i = 1; i < lanes.length; i++) {
      if (lanes[i] === null && !isBlocked(i, fromRow, toRow)) return i;
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  const reserve = (sha: string, lane: number, untilRow: number) => {
    lanes[lane] = sha;
    laneOf.set(sha, lane);
    reserved.push({ lane, untilRow });
  };

  commits.forEach((commit, row) => {
    // The lane was claimed by whichever child got here first; otherwise this is
    // the tip of a branch and needs a new one.
    let lane = laneOf.get(commit.sha) ?? -1;
    if (lane === -1 || lanes[lane] !== commit.sha) {
      lane = trunk.has(commit.sha) ? 0 : freeLane(row, row);
      if (lanes.length === 0) lanes.push(null);
      lanes[lane] = commit.sha;
      laneOf.set(commit.sha, lane);
    }

    const active = lanes
      .map((sha, index) => (sha !== null ? index : -1))
      .filter((index) => index !== -1);
    if (!active.includes(lane)) active.push(lane);

    lanes[lane] = null;

    const edges: GraphEdge[] = [];

    commit.parents.forEach((parent, index) => {
      const parentRow = rowOf.get(parent);
      // A parent outside the window -- history was truncated by --max-count --
      // gets no edge; drawing one to nowhere is worse than drawing none.
      if (parentRow === undefined) return;

      const already = laneOf.get(parent);
      if (already !== undefined && lanes[already] === parent) {
        edges.push({ fromLane: lane, toLane: already, toRow: parentRow, isMerge: index > 0 });
        return;
      }

      // The first parent inherits this lane only if this commit is the child
      // that continues its branch. That single condition is what keeps a branch
      // on one column instead of drifting.
      // A trunk parent always takes lane 0, whoever reaches it first.
      const continuesBranch =
        index === 0 && (trunk.has(parent) || branchChild.get(parent) === commit.sha);

      const target = trunk.has(parent)
        ? 0
        : continuesBranch && !isBlocked(lane, row, parentRow)
          ? lane
          : freeLane(row, parentRow);

      reserve(parent, target, parentRow);
      edges.push({ fromLane: lane, toLane: target, toRow: parentRow, isMerge: index > 0 });
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    width = Math.max(width, lane + 1, ...active.map((a) => a + 1));
    rows.push({ commit, lane, active, edges });
  });

  return { rows, width };
};
