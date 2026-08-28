"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";

import { cn } from "@/lib/utils";
import { getGeometry } from "@/lib/arch/shapes";
import {
  HANDLE_SIDES,
  type ArchNode,
  type HandleSide,
  type ShapeTone,
} from "@/types/arch";

const HANDLE_POSITION: Record<HandleSide, Position> = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
};

const TONES: Record<ShapeTone, { fill: string; stroke: string; text: string }> = {
  neutral: { fill: "#ffffff", stroke: "#94a3b8", text: "#1e293b" },
  blue: { fill: "#eff6ff", stroke: "#60a5fa", text: "#1e3a8a" },
  green: { fill: "#f0fdf4", stroke: "#4ade80", text: "#14532d" },
  amber: { fill: "#fffbeb", stroke: "#fbbf24", text: "#78350f" },
  red: { fill: "#fef2f2", stroke: "#f87171", text: "#7f1d1d" },
  violet: { fill: "#f5f3ff", stroke: "#a78bfa", text: "#4c1d95" },
  cyan: { fill: "#ecfeff", stroke: "#22d3ee", text: "#164e63" },
};

/**
 * The generic diagram shape.
 *
 * The outline is an SVG path sized from the node's own box, so one component
 * covers every geometry in the catalog. Double-clicking edits the label in
 * place, which is the interaction people expect from a diagramming tool.
 */
export const ShapeNode = memo(({ id, data, selected, width, height }: NodeProps<ArchNode>) => {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (data.kind !== "shape") {
    return null;
  }

  const geometry = getGeometry(data.geometry);
  const w = width ?? geometry.defaultSize.w;
  const h = height ?? geometry.defaultSize.h;
  // Node data comes from localStorage and from importers, so an unknown tone
  // or geometry is reachable in practice. Falling back beats crashing the
  // whole canvas over one bad node.
  const tone = TONES[data.tone as ShapeTone] ?? TONES.neutral;
  const [outline, ...details] = geometry.paths(w, h);
  const inset = geometry.inset?.(w, h) ?? { x: 0, y: 0 };

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={60}
        minHeight={40}
        lineClassName="!border-blue-400"
        handleClassName="!h-2 !w-2 !rounded-sm !border-blue-500 !bg-white"
      />

      <div className="group relative" style={{ width: w, height: h }}>
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="absolute inset-0 overflow-visible"
          style={data.translucent ? { mixBlendMode: "multiply" } : undefined}
        >
          <path
            d={outline}
            fill={data.translucent ? tone.stroke : tone.fill}
            // A Venn set has to let the shapes beneath it show through, which
            // is what turns an overlap into a readable intersection.
            fillOpacity={data.translucent ? 0.35 : 1}
            stroke={selected ? "#3b82f6" : tone.stroke}
            strokeWidth={selected ? 2 : 1.5}
            strokeLinejoin="round"
          />
          {details.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke={selected ? "#3b82f6" : tone.stroke}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ))}
        </svg>

        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ padding: `${inset.y + 6}px ${inset.x + 8}px` }}
          onDoubleClick={() => setEditing(true)}
        >
          {editing ? (
            <textarea
              ref={inputRef}
              // `nodrag` stops React Flow treating a text selection as a drag.
              className="nodrag h-full w-full resize-none border-0 bg-transparent text-center text-[13px] leading-tight outline-none"
              style={{ color: tone.text }}
              defaultValue={data.label}
              onBlur={(e) => {
                updateNodeData(id, { label: e.target.value });
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span
              className="select-none whitespace-pre-wrap break-words text-center text-[13px] leading-tight"
              style={{ color: tone.text }}
            >
              {data.label}
            </span>
          )}
        </div>

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
    </>
  );
});

ShapeNode.displayName = "ShapeNode";
