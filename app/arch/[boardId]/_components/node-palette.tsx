"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { TechIcon } from "@/lib/arch/icons/resolve";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  searchTech,
  type TechCategory,
  type TechDef,
} from "@/lib/arch/tech-catalog";
import {
  FAMILY_LABELS,
  FAMILY_ORDER,
  GEOMETRIES,
  geometriesFor,
  type DiagramFamily,
  type Geometry,
} from "@/lib/arch/shapes";
import type { DiagramType } from "@/types/arch";

/**
 * Composite nodes are not geometries -- they have their own internal
 * structure -- so the library offers them as named elements rather than
 * outlines.
 */
export type SpecialNode = "umlclass" | "table";

const SPECIALS: { id: SpecialNode; label: string; hint: string }[] = [
  { id: "umlclass", label: "UML class", hint: "name / attributes / operations" },
  { id: "table", label: "DB table", hint: "columns with keys" },
];

/** Which shape family a diagram type leads with, when it has one. */
const FAMILY_FOR_TYPE: Partial<Record<DiagramType, DiagramFamily>> = {
  flowchart: "flowchart",
  bpmn: "bpmn",
  dfd: "dfd",
  uml: "uml",
  network: "network",
  sitemap: "sitemap",
  orgchart: "orgchart",
  block: "block",
  venn: "venn",
  mindmap: "mindmap",
};

type Filter = "all" | "shapes" | "tech";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "shapes", label: "Shapes" },
  { id: "tech", label: "Technology" },
];

interface NodePaletteProps {
  onPick: (tech: TechDef) => void;
  onPickShape: (geometry: Geometry) => void;
  onPickSpecial: (special: SpecialNode) => void;
  onClose: () => void;
  /** "replace" retargets an existing node's technology, so shapes don't apply. */
  techOnly?: boolean;
  /** Reorders the list to lead with this board's family. Never hides anything. */
  diagramType?: DiagramType;
}

export const NodePalette = ({
  onPick,
  onPickShape,
  onPickSpecial,
  onClose,
  techOnly,
  diagramType = "architecture",
}: NodePaletteProps) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const isSearching = q.length > 0;

  // A board is never locked to one diagram type -- people mix a flowchart, an
  // ER table and a couple of service nodes on the same canvas all the time.
  // So the board's family is only promoted to the top; nothing is hidden.
  const leadFamily = FAMILY_FOR_TYPE[diagramType];
  const families = useMemo(
    () => [
      ...(leadFamily ? [leadFamily] : []),
      ...FAMILY_ORDER.filter((f) => f !== leadFamily),
    ],
    [leadFamily],
  );

  const showShapes = !techOnly && filter !== "tech";
  const showTech = filter !== "shapes";

  const techResults = useMemo(() => searchTech(query, 300), [query]);

  const shapeResults = useMemo(
    () =>
      isSearching
        ? GEOMETRIES.filter(
            (g) =>
              g.label.toLowerCase().includes(q) ||
              g.id.includes(q) ||
              g.families.some((f) => FAMILY_LABELS[f].toLowerCase().includes(q)),
          )
        : [],
    [isSearching, q],
  );

  const groupedTech = useMemo(() => {
    if (isSearching) return null;
    const map = new Map<TechCategory, TechDef[]>();
    for (const tech of techResults) {
      const list = map.get(tech.category) ?? [];
      list.push(tech);
      map.set(tech.category, list);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
      category: c,
      items: map.get(c)!,
    }));
  }, [techResults, isSearching]);

  const nothingFound =
    isSearching &&
    (!showShapes || shapeResults.length === 0) &&
    (!showTech || techResults.length === 0);

  return (
    <div className="absolute left-[76px] top-[50%] z-20 flex max-h-[74vh] w-[330px] -translate-y-[50%] flex-col rounded-lg border border-line bg-panel shadow-lg">
      <div className="flex items-center gap-x-2 border-b p-2">
        <Search className="ml-1 h-4 w-4 shrink-0 text-fg-subtle" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shapes and technologies..."
          className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
        />
        <button
          onClick={onClose}
          className="rounded p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg"
          aria-label="Close palette"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!techOnly ? (
        <div className="flex gap-x-1 border-b px-2 py-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.id
                  ? "bg-brand text-brand-fg"
                  : "text-fg-muted hover:bg-bg-subtle",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="overflow-y-auto p-2">
        {nothingFound ? (
          <p className="px-2 py-8 text-center text-sm text-fg-subtle">
            Nothing matches &ldquo;{query}&rdquo;
          </p>
        ) : (
          <>
            {showShapes && !isSearching ? (
              <Section title="Diagram elements">
                <div className="grid grid-cols-1 gap-0.5">
                  {SPECIALS.map((special) => (
                    <button
                      key={special.id}
                      onClick={() => onPickSpecial(special.id)}
                      className="flex items-center justify-between rounded px-2 py-1.5 text-left hover:bg-bg-subtle focus:bg-bg-subtle focus:outline-none"
                    >
                      <span className="text-sm text-fg">
                        {special.label}
                      </span>
                      <span className="text-[10px] text-fg-subtle">
                        {special.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </Section>
            ) : null}

            {showShapes && isSearching && shapeResults.length ? (
              <Section title="Shapes">
                <ShapeGrid items={shapeResults} onPick={onPickShape} />
              </Section>
            ) : null}

            {showShapes && !isSearching
              ? families.map((family) => {
                  const items = geometriesFor(family);
                  if (!items.length) return null;
                  return (
                    <Section key={family} title={FAMILY_LABELS[family]}>
                      <ShapeGrid items={items} onPick={onPickShape} />
                    </Section>
                  );
                })
              : null}

            {showTech && isSearching && techResults.length ? (
              <Section title="Technology">
                <TechGrid items={techResults} onPick={onPick} />
              </Section>
            ) : null}

            {showTech && !isSearching
              ? groupedTech!.map(({ category, items }) => (
                  <Section key={category} title={CATEGORY_LABELS[category]}>
                    <TechGrid items={items} onPick={onPick} />
                  </Section>
                ))
              : null}
          </>
        )}
      </div>
    </div>
  );
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div className="mb-3">
    <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
      {title}
    </p>
    {children}
  </div>
);

/** Each swatch previews the real geometry, drawn at swatch size. */
const ShapeGrid = ({
  items,
  onPick,
}: {
  items: Geometry[];
  onPick: (g: Geometry) => void;
}) => (
  <div className="grid grid-cols-4 gap-1">
    {items.map((geometry) => {
      const [outline, ...details] = geometry.paths(46, 32);
      return (
        <button
          key={geometry.id}
          onClick={() => onPick(geometry)}
          title={geometry.label}
          className="flex flex-col items-center gap-y-1 rounded p-1.5 hover:bg-bg-subtle focus:bg-bg-subtle focus:outline-none"
        >
          <svg width={46} height={32} viewBox="0 0 46 32" className="overflow-visible">
            <path d={outline} fill="#ffffff" stroke="#64748b" strokeWidth={1.4} strokeLinejoin="round" />
            {details.map((d) => (
              <path key={d} d={d} fill="none" stroke="#64748b" strokeWidth={1.4} />
            ))}
          </svg>
          <span className="w-full truncate text-center text-[9px] leading-tight text-fg-muted">
            {geometry.label}
          </span>
        </button>
      );
    })}
  </div>
);

const TechGrid = ({
  items,
  onPick,
}: {
  items: TechDef[];
  onPick: (tech: TechDef) => void;
}) => (
  <div className="grid grid-cols-1 gap-0.5">
    {items.map((tech) => (
      <button
        key={tech.id}
        onClick={() => onPick(tech)}
        className="flex items-center gap-x-2.5 rounded px-2 py-1.5 text-left hover:bg-bg-subtle focus:bg-bg-subtle focus:outline-none"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <TechIcon techId={tech.id} size={17} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {tech.label}
        </span>
        {tech.provider ? (
          <span className="shrink-0 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] uppercase text-fg-muted">
            {tech.provider}
          </span>
        ) : null}
      </button>
    ))}
  </div>
);
