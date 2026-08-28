"use client";

import { memo } from "react";
import { KeyRound, Link2, Table2 } from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { columnHandleId, type ArchNode, type Column } from "@/types/arch";

/**
 * A database table.
 *
 * Every column row carries a handle on each side, and the column id is encoded
 * into the handle id. That is what makes a foreign key bind at *column* level:
 * an edge's `sourceHandle`/`targetHandle` name the columns, so no separate
 * column-to-column mapping has to be stored or kept in sync.
 *
 * Height is driven by the column count, so this node is never a fixed size --
 * auto-layout has to wait for React Flow to measure it.
 */
export const TableNode = memo(({ data, selected }: NodeProps<ArchNode>) => {
  if (data.kind !== "table") {
    return null;
  }

  return (
    <div
      className={cn(
        "min-w-[230px] rounded-lg border bg-white shadow-sm",
        selected ? "border-blue-500 shadow-md" : "border-neutral-200",
      )}
    >
      <div className="flex items-center gap-x-2 rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <Table2 className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="truncate text-sm font-semibold text-neutral-800">
          {data.label}
        </span>
        {data.schema ? (
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-neutral-400">
            {data.schema}
          </span>
        ) : null}
      </div>

      <div className="py-1">
        {data.columns.length === 0 ? (
          <p className="px-3 py-2 text-xs italic text-neutral-400">No columns</p>
        ) : (
          data.columns.map((column) => (
            <ColumnRow key={column.id} column={column} />
          ))
        )}
      </div>
    </div>
  );
});

TableNode.displayName = "TableNode";

const ColumnRow = ({ column }: { column: Column }) => (
  // `relative` so the two handles sit on this row's edges rather than the
  // node's -- React Flow measures handle positions straight from the DOM.
  <div className="relative flex items-center gap-x-2 px-3 py-[3px] hover:bg-neutral-50">
    <Handle
      id={columnHandleId(column.id, "l")}
      type="source"
      position={Position.Left}
      className="!left-0 !h-1.5 !w-1.5 !min-w-0 !border !border-white !bg-neutral-300"
    />

    <span className="flex w-3.5 shrink-0 justify-center">
      {column.pk ? (
        <KeyRound className="h-3 w-3 text-amber-500" />
      ) : column.fk ? (
        <Link2 className="h-3 w-3 text-blue-400" />
      ) : null}
    </span>

    <span
      className={cn(
        "min-w-0 flex-1 truncate text-xs",
        column.pk ? "font-medium text-neutral-900" : "text-neutral-700",
      )}
    >
      {column.name}
    </span>

    <span className="shrink-0 text-[10px] text-neutral-400">
      {column.type}
      {column.nullable === false ? " *" : ""}
    </span>

    <Handle
      id={columnHandleId(column.id, "r")}
      type="source"
      position={Position.Right}
      className="!right-0 !h-1.5 !w-1.5 !min-w-0 !border !border-white !bg-neutral-300"
    />
  </div>
);
