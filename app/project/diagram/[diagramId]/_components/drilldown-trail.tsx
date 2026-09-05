"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { TrailStep } from "@/lib/project/drilldown";

/**
 * The way back out of a drill-down.
 *
 * Rendered only when there is somewhere to go, so an ordinary diagram is not
 * given a breadcrumb reading just its own name. `?root=` is carried through
 * every link -- the whole trail is meaningless if it walks you into a different
 * project's diagrams halfway up.
 */
export const DrilldownTrail = ({
  trail,
  title,
  root,
}: {
  trail: TrailStep[];
  title: string;
  root?: string;
}) => {
  if (!trail.length) return null;
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  return (
    <nav
      aria-label="Drill-down trail"
      className="pointer-events-auto absolute left-1/2 top-[68px] z-10 flex -translate-x-1/2 items-center gap-x-1 rounded-full border border-neutral-200 bg-white/95 px-3 py-1 text-xs shadow-sm backdrop-blur"
    >
      {trail.map((step) => (
        <span key={step.diagramId} className="flex items-center gap-x-1">
          <Link
            href={`/project/diagram/${encodeURIComponent(step.diagramId)}${query}`}
            className="max-w-[160px] truncate text-neutral-500 transition-colors hover:text-neutral-900"
          >
            {step.title}
          </Link>
          <ChevronRight size={12} className="shrink-0 text-neutral-300" />
        </span>
      ))}
      <span className="max-w-[180px] truncate font-medium text-neutral-900">{title}</span>
    </nav>
  );
};
