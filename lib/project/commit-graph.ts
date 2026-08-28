/**
 * Lane assignment for a commit DAG.
 *
 * The familiar railway diagram: each commit sits in a lane, a lane continues
 * down through a commit's first parent, and a merge opens a second lane that
 * later rejoins. Walking newest-first means a commit's lane is already claimed
 * by whichever child reached it first, which is what keeps a branch on one
 * vertical line instead of zig-zagging.
 *
 * Small enough not to warrant a dependency, and the input is already in the
 * topological order `git log` produced.
 */

export type GraphRow<T extends { sha: string; parents: string[] }> = {
  commit: T;
  lane: number;
  /** Lanes occupied on this row, so the renderer can draw the pass-through lines. */
  active: number[];
  /** Lane each parent continues into, for the connecting edges. */
  parentLanes: number[];
};

export const buildGraph = <T extends { sha: string; parents: string[] }>(
  commits: T[],
): { rows: GraphRow<T>[]; width: number } => {
  // `lanes[i]` is the sha that lane i is currently waiting to draw.
  const lanes: (string | null)[] = [];
  const rows: GraphRow<T>[] = [];
  let width = 0;

  const claim = (sha: string): number => {
    const existing = lanes.indexOf(sha);
    if (existing !== -1) return existing;
    const free = lanes.indexOf(null);
    if (free !== -1) {
      lanes[free] = sha;
      return free;
    }
    lanes.push(sha);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const lane = claim(commit.sha);

    const active = lanes
      .map((sha, index) => (sha ? index : -1))
      .filter((index) => index !== -1);

    // The first parent inherits this lane; the rest fork into their own.
    const parentLanes: number[] = [];
    lanes[lane] = null;

    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        lanes[lane] = parent;
        parentLanes.push(lane);
      } else {
        parentLanes.push(claim(parent));
      }
    });

    // Trim trailing empties so a long-dead branch does not pad every later row.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    width = Math.max(width, lane + 1, ...active.map((a) => a + 1));
    rows.push({ commit, lane, active, parentLanes });
  }

  return { rows, width };
};
