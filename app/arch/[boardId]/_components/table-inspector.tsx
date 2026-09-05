"use client";

import { nanoid } from "nanoid";
import { ChevronDown, ChevronUp, KeyRound, Link2, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Column, TableData } from "@/types/arch";

/**
 * Column editor for a database table.
 *
 * Without this a schema can only arrive by importing SQL or Prisma -- you can
 * drop a table on the canvas but never give it columns, which makes designing
 * a schema in place impossible.
 *
 * Column ids are stable and never regenerated on edit: an edge's handle id
 * encodes the column it joins on, so changing an id would silently detach
 * every foreign key pointing at it.
 */

const FLAGS: { key: keyof Column; label: string; title: string }[] = [
  { key: "pk", label: "PK", title: "Primary key" },
  { key: "fk", label: "FK", title: "Foreign key" },
  { key: "unique", label: "U", title: "Unique" },
];

interface TableInspectorProps {
  data: TableData;
  onChange: (patch: Partial<TableData>) => void;
}

export const TableInspector = ({ data, onChange }: TableInspectorProps) => {
  const setColumns = (columns: Column[]) => onChange({ columns });

  const update = (id: string, patch: Partial<Column>) =>
    setColumns(
      data.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );

  const move = (index: number, delta: number) => {
    const next = [...data.columns];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setColumns(next);
  };

  return (
    <aside className="absolute right-2 top-16 z-20 flex max-h-[calc(100vh-5rem)] w-[320px] flex-col rounded-lg border border-line bg-panel shadow-lg">
      <div className="border-b p-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          Table
        </p>
        <div className="flex gap-x-2">
          <Input
            value={data.schema ?? ""}
            placeholder="schema"
            onChange={(e) => onChange({ schema: e.target.value || undefined })}
            className="h-8 w-[92px] text-xs"
          />
          <Input
            value={data.label}
            placeholder="table_name"
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-8 flex-1 font-medium"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {data.columns.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-fg-subtle">
            No columns yet.
          </p>
        ) : null}

        {data.columns.map((column, index) => (
          <div
            key={column.id}
            className="mb-1.5 rounded-md border border-line p-1.5"
          >
            <div className="mb-1 flex items-center gap-x-1">
              <span className="flex w-4 shrink-0 justify-center">
                {column.pk ? (
                  <KeyRound className="h-3 w-3 text-amber-500" />
                ) : column.fk ? (
                  <Link2 className="h-3 w-3 text-blue-400" />
                ) : null}
              </span>
              <Input
                value={column.name}
                placeholder="column"
                onChange={(e) => update(column.id, { name: e.target.value })}
                className="h-7 flex-1 text-xs"
              />
              <Input
                value={column.type}
                placeholder="type"
                onChange={(e) => update(column.id, { type: e.target.value })}
                className="h-7 w-[86px] text-xs text-fg-muted"
              />
            </div>

            <div className="flex items-center gap-x-1 pl-5">
              {FLAGS.map((flag) => (
                <button
                  key={flag.key}
                  title={flag.title}
                  onClick={() =>
                    update(column.id, { [flag.key]: !column[flag.key] })
                  }
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                    column[flag.key]
                      ? "bg-brand text-brand-fg"
                      : "bg-bg-subtle text-fg-muted hover:bg-neutral-200",
                  )}
                >
                  {flag.label}
                </button>
              ))}
              <button
                title="Not null"
                onClick={() =>
                  update(column.id, {
                    nullable: column.nullable === false ? undefined : false,
                  })
                }
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                  column.nullable === false
                    ? "bg-brand text-brand-fg"
                    : "bg-bg-subtle text-fg-muted hover:bg-neutral-200",
                )}
              >
                NOT NULL
              </button>

              <span className="ml-auto flex items-center">
                <button
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="rounded p-0.5 text-fg-subtle hover:bg-bg-subtle disabled:opacity-25"
                  title="Move up"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  onClick={() => move(index, 1)}
                  disabled={index === data.columns.length - 1}
                  className="rounded p-0.5 text-fg-subtle hover:bg-bg-subtle disabled:opacity-25"
                  title="Move down"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
                <button
                  onClick={() =>
                    setColumns(data.columns.filter((c) => c.id !== column.id))
                  }
                  className="rounded p-0.5 text-fg-subtle hover:bg-red-50 hover:text-red-500"
                  title="Delete column"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t p-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-full justify-start gap-x-1.5 text-xs"
          onClick={() =>
            setColumns([
              ...data.columns,
              { id: nanoid(8), name: "", type: "text" },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Add column
        </Button>
      </div>
    </aside>
  );
};
