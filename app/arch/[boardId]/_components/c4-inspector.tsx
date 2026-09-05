"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { C4Data, C4Element, NoteData } from "@/types/arch";

/**
 * Editors for the two node kinds that had none.
 *
 * `c4` and `note` were declared in `ArchNodeKind` long before either had a
 * component, and adding the components alone would have left them creatable by
 * an agent and uneditable by a person -- a node you can see and cannot change
 * is half a feature.
 */

const ELEMENTS: { value: C4Element; label: string }[] = [
  { value: "person", label: "Person" },
  { value: "system", label: "System" },
  { value: "container", label: "Container" },
  { value: "component", label: "Component" },
  { value: "external", label: "External" },
];

/**
 * The diagrams this one could open into.
 *
 * Fetched here rather than threaded down from the canvas, because the canvas is
 * mounted twice -- once against the project and once against localStorage --
 * and only one of those has diagrams to list. A failed fetch degrades to a
 * plain text field rather than removing the control, so the scratch canvas can
 * still point at a diagram by id.
 */
const useDiagramOptions = (excludeId?: string) => {
  const [options, setOptions] = useState<{ id: string; title: string }[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/project/diagrams")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { diagrams?: { id: string; title: string; kind?: string }[] }) => {
        if (!live) return;
        setOptions(
          (body.diagrams ?? [])
            .filter((d) => (d.kind ?? "diagram") === "diagram" && d.id !== excludeId)
            .map((d) => ({ id: d.id, title: d.title })),
        );
      })
      .catch(() => live && setOptions([]));
    return () => {
      live = false;
    };
  }, [excludeId]);

  return options;
};

const Drilldown = ({
  value,
  onChange,
}: {
  value?: string;
  onChange: (id: string | undefined) => void;
}) => {
  const options = useDiagramOptions();

  return (
    <>
      <label className="mb-1 block text-xs text-fg-muted">Opens into</label>
      {options && options.length ? (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm text-fg"
        >
          <option value="">Nothing</option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      ) : (
        <Input
          value={value ?? ""}
          placeholder="diagram id"
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-8"
        />
      )}
    </>
  );
};

export const C4Inspector = ({
  data,
  onChange,
}: {
  data: C4Data;
  onChange: (patch: Partial<C4Data>) => void;
}) => (
  <aside className="absolute right-2 top-16 z-20 w-[268px] rounded-lg border border-line bg-panel p-3 shadow-lg">
    <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
      C4 element
    </p>

    {/* A segmented row rather than a select: there are five, they never grow,
        and the level is the first thing you change.

        `brand`, not `accent`. Two colour systems share this config -- the
        product palette and the shadcn one -- and they collide on that name:
        shadcn's `accent` reads `hsl(var(--accent))` while `--accent` is an RGB
        triple, so `hsl(110 86 207)` clamps to white. It compiles, it looks
        right in the class list, and it renders white text on a white panel. */}
    <div className="mb-3 grid grid-cols-5 gap-x-1">
      {ELEMENTS.map((element) => (
        <button
          key={element.value}
          type="button"
          title={element.label}
          onClick={() => onChange({ element: element.value })}
          className={cn(
            "rounded border px-1 py-1 text-[10px] font-medium transition-colors",
            data.element === element.value
              ? "border-brand bg-brand/10 text-brand"
              : "border-line text-fg-subtle hover:text-fg",
          )}
        >
          {element.label.slice(0, 4)}
        </button>
      ))}
    </div>

    <label className="mb-1 block text-xs text-fg-muted">Label</label>
    <Input
      value={data.label}
      onChange={(e) => onChange({ label: e.target.value })}
      className="mb-3 h-8"
    />

    <label className="mb-1 block text-xs text-fg-muted">Technology</label>
    <Input
      value={data.technology ?? ""}
      placeholder="Go, Postgres, React"
      onChange={(e) => onChange({ technology: e.target.value || undefined })}
      className="mb-3 h-8"
    />

    <label className="mb-1 block text-xs text-fg-muted">Description</label>
    <textarea
      value={data.description ?? ""}
      placeholder="What it does, in a line."
      onChange={(e) => onChange({ description: e.target.value || undefined })}
      className="mb-3 h-16 w-full resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle"
    />

    <Drilldown
      value={data.drilldownDiagramId}
      onChange={(drilldownDiagramId) => onChange({ drilldownDiagramId })}
    />
  </aside>
);

export const NoteInspector = ({
  data,
  onChange,
}: {
  data: NoteData;
  onChange: (patch: Partial<NoteData>) => void;
}) => (
  <aside className="absolute right-2 top-16 z-20 w-[268px] rounded-lg border border-line bg-panel p-3 shadow-lg">
    <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
      Note
    </p>
    <textarea
      value={data.label}
      placeholder="Something the boxes cannot say."
      onChange={(e) => onChange({ label: e.target.value })}
      className="h-28 w-full resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle"
    />
  </aside>
);
