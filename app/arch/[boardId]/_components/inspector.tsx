"use client";

import { Replace } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getTech } from "@/lib/arch/tech-catalog";
import { TechIcon, iconLicense } from "@/lib/arch/icons/resolve";
import { cn } from "@/lib/utils";
import { TableInspector } from "./table-inspector";
import {
  DIAGRAM_TYPE_IDS,
  DIAGRAM_TYPE_LABELS,
  type ArchNode,
  type DiagramType,
  type GroupData,
  type ServiceData,
  type ShapeData,
  type ShapeTone,
  type TableData,
} from "@/types/arch";
import { GEOMETRIES, getGeometry } from "@/lib/arch/shapes";

interface InspectorProps {
  node: ArchNode;
  onChange: (
    patch:
      | Partial<ServiceData>
      | Partial<GroupData>
      | Partial<ShapeData>
      | Partial<TableData>,
  ) => void;
  onChangeTech: () => void;
}

const GROUP_VARIANTS: GroupData["variant"][] = [
  "frame",
  "boundary",
  "region",
  "vpc",
  "subnet",
  "cluster",
];

export const Inspector = ({ node, onChange, onChangeTech }: InspectorProps) => {
  if (node.data.kind === "table") {
    return <TableInspector data={node.data} onChange={onChange} />;
  }

  if (node.data.kind === "shape") {
    return <ShapeInspector data={node.data} onChange={onChange} />;
  }

  if (node.data.kind === "group") {
    return <GroupInspector data={node.data} onChange={onChange} />;
  }

  if (node.data.kind !== "service") {
    return null;
  }

  const data = node.data;
  const tech = getTech(data.tech);
  const restricted = tech && iconLicense(tech.id) === "vendor-restricted";

  return (
    <aside className="absolute right-2 top-2 z-20 w-[268px] rounded-lg border border-line bg-panel p-3 shadow-lg">
      <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        Node
      </p>

      <div className="mb-3 flex items-center gap-x-2.5 rounded-md border border-line p-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-bg-subtle">
          <TechIcon techId={data.tech} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg">
            {tech?.label ?? "No technology"}
          </p>
          {restricted ? (
            <p className="truncate text-[10px] text-fg-subtle">
              Vendor mark &middot; not recoloured
            </p>
          ) : null}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={onChangeTech}
          title="Change technology"
        >
          <Replace className="h-3.5 w-3.5" />
        </Button>
      </div>

      <label className="mb-1 block text-xs text-fg-muted">Label</label>
      <Input
        value={data.label}
        onChange={(e) => onChange({ label: e.target.value })}
        className="mb-3 h-8"
      />

      <label className="mb-1 block text-xs text-fg-muted">Sublabel</label>
      <Input
        value={data.sublabel ?? ""}
        placeholder="v16 - primary"
        onChange={(e) => onChange({ sublabel: e.target.value })}
        className="h-8"
      />
    </aside>
  );
};

const GroupInspector = ({
  data,
  onChange,
}: {
  data: GroupData;
  onChange: (patch: Partial<GroupData>) => void;
}) => (
  <aside className="absolute right-2 top-2 z-20 w-[268px] rounded-lg border border-line bg-panel p-3 shadow-lg">
    <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
      Container
    </p>

    <label className="mb-1 block text-xs text-fg-muted">Label</label>
    <Input
      value={data.label}
      onChange={(e) => onChange({ label: e.target.value })}
      className="mb-3 h-8"
    />

    <label className="mb-1.5 block text-xs text-fg-muted">Type</label>
    <div className="flex flex-wrap gap-1">
      {GROUP_VARIANTS.map((variant) => (
        <button
          key={variant}
          onClick={() =>
            onChange(
              // A frame needs a diagram type to lay out by; seed it rather than
              // leaving the frame indistinguishable from a plain boundary.
              variant === "frame" && !data.diagramType
                ? { variant, diagramType: "flowchart" }
                : { variant },
            )
          }
          className={cn(
            "rounded border px-2 py-1 text-xs capitalize transition-colors",
            data.variant === variant
              ? "border-brand bg-brand-subtle text-blue-700"
              : "border-line text-fg-muted hover:bg-bg-subtle",
          )}
        >
          {variant}
        </button>
      ))}
    </div>

    {data.variant === "frame" ? (
      <>
        <label className="mb-1 mt-3 block text-xs text-fg-muted">Diagram</label>
        <select
          value={data.diagramType ?? "flowchart"}
          onChange={(e) => onChange({ diagramType: e.target.value as DiagramType })}
          className="h-8 w-full rounded-md border border-line px-2 text-xs outline-none focus:border-brand"
        >
          {DIAGRAM_TYPE_IDS.map((id) => (
            <option key={id} value={id}>
              {DIAGRAM_TYPE_LABELS[id]}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-[11px] leading-snug text-fg-subtle">
          Tidy up lays this frame out under its own rules, so it can hold a different
          kind of diagram from the rest of the board.
        </p>
      </>
    ) : null}
  </aside>
);

const TONES: { id: ShapeTone; swatch: string }[] = [
  { id: "neutral", swatch: "#ffffff" },
  { id: "blue", swatch: "#dbeafe" },
  { id: "green", swatch: "#dcfce7" },
  { id: "amber", swatch: "#fef3c7" },
  { id: "red", swatch: "#fee2e2" },
  { id: "violet", swatch: "#ede9fe" },
  { id: "cyan", swatch: "#cffafe" },
];

const ShapeInspector = ({
  data,
  onChange,
}: {
  data: ShapeData;
  onChange: (patch: Partial<ShapeData>) => void;
}) => {
  const current = getGeometry(data.geometry);

  return (
    <aside className="absolute right-2 top-2 z-20 max-h-[80vh] w-[268px] overflow-y-auto rounded-lg border border-line bg-panel p-3 shadow-lg">
      <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        Shape
      </p>

      <label className="mb-1 block text-xs text-fg-muted">Label</label>
      <Input
        value={data.label}
        onChange={(e) => onChange({ label: e.target.value })}
        className="mb-3 h-8"
      />

      <label className="mb-1.5 block text-xs text-fg-muted">Colour</label>
      <div className="mb-3 flex flex-wrap gap-1">
        {TONES.map((tone) => (
          <button
            key={tone.id}
            onClick={() => onChange({ tone: tone.id })}
            title={tone.id}
            style={{ backgroundColor: tone.swatch }}
            className={cn(
              "h-6 w-6 rounded border-2 transition-colors",
              (data.tone ?? "neutral") === tone.id
                ? "border-brand"
                : "border-line hover:border-neutral-400",
            )}
          />
        ))}
      </div>

      <label className="mb-1.5 block text-xs text-fg-muted">
        Geometry &middot; {current.label}
      </label>
      <div className="grid grid-cols-5 gap-1">
        {GEOMETRIES.map((geometry) => {
          const [outline, ...details] = geometry.paths(30, 22);
          const active = geometry.id === data.geometry;
          return (
            <button
              key={geometry.id}
              onClick={() => onChange({ geometry: geometry.id })}
              title={geometry.label}
              className={cn(
                "flex items-center justify-center rounded border p-1 transition-colors",
                active
                  ? "border-brand bg-brand-subtle"
                  : "border-line hover:bg-bg-subtle",
              )}
            >
              <svg width={30} height={22} viewBox="0 0 30 22" className="overflow-visible">
                <path d={outline} fill="#fff" stroke="#64748b" strokeWidth={1.3} strokeLinejoin="round" />
                {details.map((d) => (
                  <path key={d} d={d} fill="none" stroke="#64748b" strokeWidth={1.3} />
                ))}
              </svg>
            </button>
          );
        })}
      </div>
    </aside>
  );
};
