"use client";

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";

import type { ArchEdge } from "@/types/arch";
import { useEdgeLabelOffset } from "@/lib/arch/edge-labels";

import { MARKER_ARROW } from "../markers";

/**
 * A call between two services. `async` edges (queues, events, webhooks) render
 * dashed and animated so a request path reads differently from a fire-and-forget one.
 */
export const FlowEdge = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    selected,
  }: EdgeProps<ArchEdge>) => {
    const flow = data?.kind === "flow" ? data : undefined;
    const geom = {
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    };

    // Flowcharts read best orthogonal; architecture diagrams often prefer a
    // curve, so the routing is per-edge rather than global.
    const [path, labelX, labelY] =
      flow?.line === "bezier"
        ? getBezierPath(geom)
        : flow?.line === "straight"
          ? getStraightPath(geom)
          : getSmoothStepPath({ ...geom, borderRadius: 8 });

    const isAsync = flow?.async === true;
    const label = flow?.label;

    // Two edges between the same pair of columns share a midpoint; this is the
    // nudge that keeps their labels legible.
    const { dy: labelDy, ref: labelRef } = useEdgeLabelOffset(
      id,
      labelX,
      labelY,
      label,
    );

    return (
      <>
        <BaseEdge
          path={path}
          markerStart={flow?.arrowStart ? `url(#${MARKER_ARROW})` : undefined}
          markerEnd={
            flow?.arrowEnd === false ? undefined : `url(#${MARKER_ARROW})`
          }
          className={isAsync ? "animated" : undefined}
          style={{
            strokeWidth: 1.5,
            stroke: selected ? "#3b82f6" : "#94a3b8",
            strokeDasharray: isAsync ? "6 4" : undefined,
          }}
        />
        {label ? (
          <EdgeLabelRenderer>
            <div
              ref={labelRef}
              // `nodrag nopan` keeps a click on the label from panning the canvas.
              className="nodrag nopan pointer-events-auto absolute rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 shadow-sm"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + labelDy}px)`,
              }}
            >
              {label}
            </div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    );
  },
);

FlowEdge.displayName = "FlowEdge";
