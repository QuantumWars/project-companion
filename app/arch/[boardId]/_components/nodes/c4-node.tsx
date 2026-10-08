"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { User } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ACTIVE_STATUSES,
  STATUS_DOT,
  useNodeTasks,
} from "@/lib/project/task-context";
import {
  HANDLE_SIDES,
  type ArchNode,
  type C4Element,
  type HandleSide,
} from "@/types/arch";
import { DrilldownBadge } from "./drilldown-badge";

const HANDLE_POSITION: Record<HandleSide, Position> = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
};

/**
 * C4's own palette, which readers of these diagrams already know.
 *
 * Depth is carried by saturation rather than hue: a system is the darkest, a
 * container lighter, a component lighter still, so a container diagram reads as
 * one level below a context diagram at a glance. External systems are grey,
 * which is the convention for "somebody else's problem".
 */
const ELEMENT: Record<C4Element, { fill: string; border: string; text: string; label: string }> = {
  person: { fill: "#08427B", border: "#073B6F", text: "#FFFFFF", label: "Person" },
  system: { fill: "#1168BD", border: "#0E5AA7", text: "#FFFFFF", label: "System" },
  container: { fill: "#438DD5", border: "#3C7FC0", text: "#FFFFFF", label: "Container" },
  component: { fill: "#85BBF0", border: "#78A8D8", text: "#0B2E4F", label: "Component" },
  external: { fill: "#999999", border: "#8A8A8A", text: "#FFFFFF", label: "External" },
};

/**
 * A C4 element: person, system, container, component or external system.
 *
 * Declared in `ArchNodeKind` since the canvas was built and never given a
 * component, so a `c4` node rendered nothing at all -- React Flow resolves
 * `nodeTypes[node.type]`, finds nothing, and draws an empty box.
 */
export const C4Node = memo(({ id, data, selected }: NodeProps<ArchNode>) => {
  const tasks = useNodeTasks(id);

  if (data.kind !== "c4") return null;

  const style = ELEMENT[data.element] ?? ELEMENT.system;
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const isPerson = data.element === "person";

  return (
    <div
      className={cn(
        "group relative flex min-w-[180px] max-w-[260px] flex-col gap-y-1 px-4 py-3 shadow-sm transition-shadow",
        // A person is drawn as a rounded figure and everything else as a box:
        // the one shape distinction C4 makes, and the one readers rely on.
        isPerson ? "rounded-[1.6rem]" : "rounded-md",
        selected && "shadow-md ring-2 ring-blue-500 ring-offset-1",
      )}
      style={{
        backgroundColor: style.fill,
        border: `1px solid ${style.border}`,
        color: style.text,
      }}
    >
      <div className="flex items-center gap-x-1.5">
        {isPerson ? <User size={13} className="shrink-0 opacity-90" /> : null}
        <p className="truncate text-sm font-semibold leading-tight">{data.label}</p>
      </div>

      <p className="text-[10px] uppercase leading-tight tracking-wide opacity-75">
        {data.technology ? `[${style.label}: ${data.technology}]` : `[${style.label}]`}
      </p>

      {data.description ? (
        <p className="line-clamp-3 text-[11px] leading-snug opacity-90">{data.description}</p>
      ) : null}

      {active.length ? (
        <span
          title={active.map((t) => `${t.status}: ${t.title}`).join("\n")}
          className="absolute -right-1.5 -top-1.5 flex items-center gap-x-1 rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[9px] font-medium text-neutral-600 shadow-sm"
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[active[0].status])} />
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

C4Node.displayName = "C4Node";
