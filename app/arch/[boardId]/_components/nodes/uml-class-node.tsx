"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import {
  HANDLE_SIDES,
  type ArchNode,
  type HandleSide,
  type UmlMember,
  type UmlVisibility,
} from "@/types/arch";

const HANDLE_POSITION: Record<HandleSide, Position> = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
};

/** UML visibility prefixes, in the notation the spec uses. */
const VISIBILITY: Record<UmlVisibility, string> = {
  public: "+",
  private: "-",
  protected: "#",
  package: "~",
};

/**
 * A UML class: name compartment, attributes, operations.
 *
 * Like the ER table this is variable height, driven by member count, so
 * auto-layout must wait for React Flow to measure it.
 */
export const UmlClassNode = memo(({ data, selected }: NodeProps<ArchNode>) => {
  if (data.kind !== "umlclass") {
    return null;
  }

  return (
    <div
      className={cn(
        "min-w-[190px] rounded-md border bg-white shadow-sm",
        selected ? "border-blue-500 shadow-md" : "border-neutral-300",
      )}
    >
      <div className="border-b border-neutral-300 px-3 py-2 text-center">
        {data.stereotype ? (
          <p className="text-[10px] leading-tight text-neutral-500">
            &laquo;{data.stereotype}&raquo;
          </p>
        ) : null}
        <p
          className={cn(
            "truncate text-sm font-semibold text-neutral-900",
            data.abstract && "italic",
          )}
        >
          {data.label}
        </p>
      </div>

      <Compartment members={data.attributes} empty="no attributes" />
      <div className="border-t border-neutral-300" />
      <Compartment members={data.methods} empty="no operations" isMethod />

      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={HANDLE_POSITION[side]}
          className="!h-2 !w-2 !border-2 !border-white !bg-neutral-400 !opacity-0 transition-opacity hover:!opacity-100"
        />
      ))}
    </div>
  );
});

UmlClassNode.displayName = "UmlClassNode";

const Compartment = ({
  members,
  empty,
  isMethod,
}: {
  members: UmlMember[];
  empty: string;
  isMethod?: boolean;
}) => (
  <div className="px-3 py-1.5">
    {members.length === 0 ? (
      <p className="text-[11px] italic text-neutral-300">{empty}</p>
    ) : (
      members.map((member) => (
        <p
          key={member.id}
          className={cn(
            "truncate font-mono text-[11px] leading-relaxed text-neutral-700",
            member.isStatic && "underline",
          )}
        >
          <span className="text-neutral-400">
            {VISIBILITY[member.visibility ?? "public"]}
          </span>{" "}
          {member.name}
          {isMethod ? "()" : ""}
          {member.type ? (
            <span className="text-neutral-400">: {member.type}</span>
          ) : null}
        </p>
      ))
    )}
  </div>
);
