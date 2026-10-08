"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { HANDLE_SIDES, type ArchNode, type HandleSide } from "@/types/arch";

const HANDLE_POSITION: Record<HandleSide, Position> = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
};

/**
 * An annotation on the diagram: a caveat, a decision, a "why is this here".
 *
 * Deliberately the plainest node there is. It carries no tech, no status and no
 * drill-down, because the moment a note grows those it is a service wearing a
 * disguise -- and the point of a note is to say something the boxes cannot.
 *
 * Left aligned and small, so several can sit near the thing they describe
 * without competing with it for attention.
 */
export const NoteNode = memo(({ data, selected }: NodeProps<ArchNode>) => {
  if (data.kind !== "note") return null;

  return (
    <div
      className={cn(
        "group relative min-w-[150px] max-w-[240px] rounded-sm border-l-[3px] px-3 py-2",
        "border-l-amber-400 bg-amber-50/90 shadow-sm transition-shadow",
        selected ? "ring-2 ring-blue-500 ring-offset-1" : "border-y border-r border-amber-200/70",
      )}
    >
      <p className="whitespace-pre-wrap text-[11px] leading-snug text-amber-950">
        {data.label}
      </p>

      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={HANDLE_POSITION[side]}
          className={cn(
            "!h-2 !w-2 !border-2 !border-white !bg-amber-400",
            "!opacity-0 transition-opacity group-hover:!opacity-100",
            selected && "!opacity-100",
          )}
        />
      ))}
    </div>
  );
});

NoteNode.displayName = "NoteNode";
