"use client";

import type { GraphRow } from "@/lib/project/commit-graph";

/**
 * One row of the commit railway.
 *
 * Drawn per row rather than as one tall SVG so the list stays virtualisable and
 * each row can be a real, hoverable, clickable element. The cost is that an
 * edge spanning several rows must be drawn in pieces: this row draws its own
 * outgoing segment, and every row the edge passes through draws a pass-through
 * line in that lane. `active` is what makes the second part possible.
 *
 * A merge edge curves out of its lane; a branch edge stays vertical. That
 * difference is the single most useful signal in the whole diagram -- it is how
 * you see, at a glance, where work rejoined the trunk.
 */

export const LANE_COLORS = [
  "#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6",
  "#ef4444", "#14b8a6", "#ec4899", "#84cc16",
];

/** Lanes beyond this are folded into the last column rather than widening forever. */
export const MAX_LANES = 8;
const LANE_W = 14;
const ROW_H = 44;

export const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_W + 7;

export const railWidth = (width: number) =>
  Math.min(Math.max(width, 1), MAX_LANES) * LANE_W + 6;

export const CommitRail = <T extends { sha: string; parents: string[] }>({
  row,
  width,
  isTip,
  dimmed,
}: {
  row: GraphRow<T>;
  width: number;
  /** A branch or tag points here, so the node is drawn filled. */
  isTip?: boolean;
  dimmed?: boolean;
}) => {
  const w = railWidth(width);
  const cx = x(row.lane);
  const cy = ROW_H / 2;

  return (
    <svg
      width={w}
      height={ROW_H}
      className="shrink-0"
      style={{ opacity: dimmed ? 0.25 : 1 }}
      aria-hidden
    >
      {/* Lines belonging to other branches that merely pass this row. */}
      {row.active
        .filter((lane) => lane !== row.lane && lane < MAX_LANES)
        .map((lane) => (
          <line
            key={`through-${lane}`}
            x1={x(lane)}
            y1={0}
            x2={x(lane)}
            y2={ROW_H}
            stroke={laneColor(lane)}
            strokeWidth={1.5}
            opacity={0.4}
          />
        ))}

      {/* This commit's own line continuing upward to its children. */}
      <line x1={cx} y1={0} x2={cx} y2={cy} stroke={laneColor(row.lane)} strokeWidth={2} />

      {/* Edges down to each parent. */}
      {row.edges.map((edge, i) => {
        const tx = x(edge.toLane);
        if (tx === cx) {
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={cx}
              y2={ROW_H}
              stroke={laneColor(edge.toLane)}
              strokeWidth={2}
            />
          );
        }
        // A curve that leaves this lane and settles into the target within one
        // row height, so the eye follows it without the line ever going flat.
        return (
          <path
            key={i}
            d={`M ${cx} ${cy} C ${cx} ${cy + 14}, ${tx} ${cy + 6}, ${tx} ${ROW_H}`}
            fill="none"
            stroke={laneColor(edge.toLane)}
            strokeWidth={2}
            strokeDasharray={edge.isMerge ? undefined : undefined}
          />
        );
      })}

      <circle
        cx={cx}
        cy={cy}
        r={4.5}
        fill={isTip ? laneColor(row.lane) : "white"}
        stroke={laneColor(row.lane)}
        strokeWidth={2.5}
      />
    </svg>
  );
};
