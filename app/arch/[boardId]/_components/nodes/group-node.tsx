"use client";

import { memo } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { DrilldownBadge } from "./drilldown-badge";
import { TechIcon } from "@/lib/arch/icons/resolve";
import { DIAGRAM_TYPE_LABELS, type ArchNode, type GroupData } from "@/types/arch";

/**
 * A container: a frame, region, VPC, subnet, cluster, or trust boundary.
 *
 * Rendered as a React Flow subflow -- children reference it through `parentId`
 * and are clipped to it via `extent: "parent"`. Groups must sort *before* their
 * children in the nodes array or they paint over them.
 *
 * A `frame` reads as a document rather than a boundary: solid ground, a titled
 * header, and a chip naming which kind of diagram it holds. That difference is
 * the whole point -- an ER frame beside a flowchart frame should look like two
 * diagrams on one wall, not two network zones.
 */

const VARIANT: Record<
  GroupData["variant"],
  { ring: string; label: string; fill: string; dashed?: boolean }
> = {
  frame: { ring: "border-neutral-300", label: "text-neutral-700", fill: "bg-white" },
  region: { ring: "border-slate-300", label: "text-slate-600", fill: "bg-slate-500/[0.04]" },
  vpc: { ring: "border-blue-300", label: "text-blue-700", fill: "bg-blue-500/[0.04]" },
  subnet: { ring: "border-cyan-300", label: "text-cyan-700", fill: "bg-cyan-500/[0.04]" },
  cluster: { ring: "border-violet-300", label: "text-violet-700", fill: "bg-violet-500/[0.04]" },
  boundary: {
    ring: "border-neutral-400",
    label: "text-neutral-600",
    fill: "bg-transparent",
    dashed: true,
  },
};

export const GroupNode = memo(({ data, selected }: NodeProps<ArchNode>) => {
  if (data.kind !== "group") {
    return null;
  }

  const isFrame = data.variant === "frame";
  const style = VARIANT[data.variant] ?? VARIANT.boundary;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={isFrame ? 280 : 220}
        minHeight={isFrame ? 200 : 140}
        lineClassName="!border-blue-400"
        handleClassName="!h-2 !w-2 !rounded-sm !border-blue-500 !bg-white"
      />

      <div
        className={cn(
          "h-full w-full rounded-xl border-2",
          style.ring,
          style.fill,
          style.dashed && "border-dashed",
          isFrame && "shadow-sm",
          selected && "!border-blue-500",
        )}
      >
        <div
          className={cn(
            "pointer-events-none flex items-center gap-x-1.5 px-3 pt-2",
            isFrame && "border-b border-neutral-200 pb-2",
          )}
        >
          {data.provider ? (
            <TechIcon techId={data.provider === "aws" ? "aws-ec2" : data.provider} size={13} />
          ) : null}
          <span
            className={cn(
              "text-[11px] font-semibold uppercase tracking-wide",
              style.label,
            )}
          >
            {data.label}
          </span>
          {isFrame && data.diagramType ? (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-neutral-500">
              {DIAGRAM_TYPE_LABELS[data.diagramType] ?? data.diagramType}
            </span>
          ) : null}
          <DrilldownBadge diagramId={data.drilldownDiagramId} variant="inline" />
        </div>
      </div>
    </>
  );
});

GroupNode.displayName = "GroupNode";
