"use client";

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";

import type { ArchEdge, Cardinality } from "@/types/arch";
import { useEdgeLabelOffset } from "@/lib/arch/edge-labels";

import { MARKER_MANY, MARKER_ONE } from "../markers";

/** Which foot to draw at each end, read source -> target. */
const ENDS: Record<Cardinality, [start: string, end: string]> = {
  "1-1": [MARKER_ONE, MARKER_ONE],
  "1-n": [MARKER_ONE, MARKER_MANY],
  "n-1": [MARKER_MANY, MARKER_ONE],
  "n-m": [MARKER_MANY, MARKER_MANY],
};

const LABEL: Record<Cardinality, string> = {
  "1-1": "1:1",
  "1-n": "1:N",
  "n-1": "N:1",
  "n-m": "N:M",
};

/** A foreign key. Both endpoints are column handles, not whole tables. */
export const RelationEdge = memo(
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
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 6,
    });

    const cardinality: Cardinality =
      data?.kind === "relation" ? data.cardinality : "1-n";
    const [start, end] = ENDS[cardinality];
    const { dy: labelDy, ref: labelRef } = useEdgeLabelOffset(
      id,
      labelX,
      labelY,
      LABEL[cardinality],
    );

    return (
      <>
        <BaseEdge
          path={path}
          markerStart={`url(#${start})`}
          markerEnd={`url(#${end})`}
          style={{
            strokeWidth: 1.5,
            stroke: selected ? "#3b82f6" : "#94a3b8",
          }}
        />
        <EdgeLabelRenderer>
          <div
            ref={labelRef}
            className="nodrag nopan pointer-events-auto absolute rounded bg-white px-1 text-[9px] font-medium text-neutral-400"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + labelDy}px)`,
            }}
          >
            {LABEL[cardinality]}
          </div>
        </EdgeLabelRenderer>
      </>
    );
  },
);

RelationEdge.displayName = "RelationEdge";
