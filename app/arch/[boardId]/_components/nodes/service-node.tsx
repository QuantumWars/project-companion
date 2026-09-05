"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { getTech } from "@/lib/arch/tech-catalog";
import { TechIcon } from "@/lib/arch/icons/resolve";
import {
  ACTIVE_STATUSES,
  STATUS_DOT,
  useNodeTasks,
} from "@/lib/project/task-context";
import { HANDLE_SIDES, type ArchNode, type HandleSide } from "@/types/arch";
import { DrilldownBadge } from "./drilldown-badge";

const HANDLE_POSITION: Record<HandleSide, Position> = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
};

/**
 * One piece of the stack. The canvas runs in `ConnectionMode.Loose`, so each
 * side needs a single handle that serves as both source and target rather than
 * an overlapping pair.
 */
export const ServiceNode = memo(({ id, data, selected }: NodeProps<ArchNode>) => {
  const tasks = useNodeTasks(id);

  if (data.kind !== "service") {
    return null;
  }

  const tech = getTech(data.tech);
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));

  return (
    <div
      className={cn(
        "group relative flex min-w-[190px] items-center gap-x-3 rounded-lg border bg-white py-2.5 pl-4 pr-4 shadow-sm transition-shadow",
        selected ? "border-blue-500 shadow-md" : "border-neutral-200",
      )}
    >
      {/* The brand colour lives here, never on the icon itself -- vendor icon
          terms forbid recolouring the mark. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 rounded-l-lg"
        style={{ backgroundColor: tech?.color ?? "#CBD5E1" }}
      />

      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-50">
        <TechIcon techId={data.tech} size={20} />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight text-neutral-900">
          {data.label}
        </p>
        {data.sublabel ? (
          <p className="truncate text-xs leading-tight text-neutral-500">
            {data.sublabel}
          </p>
        ) : null}
      </div>

      {/* Work in flight on this part of the system. */}
      {active.length ? (
        <span
          title={active.map((t) => `${t.status}: ${t.title}`).join("\n")}
          className="absolute -right-1.5 -top-1.5 flex items-center gap-x-1 rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[9px] font-medium text-neutral-600 shadow-sm"
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[active[0].status])}
          />
          {active.length}
        </span>
      ) : null}

      <DrilldownBadge diagramId={data.drilldownDiagramId} />

      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={HANDLE_POSITION[side]}
          className={cn(
            "!h-2 !w-2 !border-2 !border-white !bg-neutral-400",
            "!opacity-0 transition-opacity group-hover:!opacity-100",
            selected && "!opacity-100",
          )}
        />
      ))}
    </div>
  );
});

ServiceNode.displayName = "ServiceNode";
