"use client";

import { Maximize2, Minus, Plus } from "lucide-react";
import { useReactFlow, useStore } from "@xyflow/react";

import { Hint } from "@/components/hint";

/**
 * Replaces React Flow's default `<Controls>` so the zoom percentage is
 * readable and the panel sits bottom-right the way a diagramming tool puts it.
 */
export const ZoomControls = () => {
  const { zoomIn, zoomOut, fitView, zoomTo } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);

  return (
    <div className="absolute bottom-3 right-3 z-20 flex items-center gap-x-0.5 rounded-lg border border-neutral-200 bg-white p-1 shadow-md">
      <Hint label="Zoom out" side="top" sideOffset={8}>
        <button
          onClick={() => zoomOut({ duration: 150 })}
          className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100"
        >
          <Minus className="h-4 w-4" />
        </button>
      </Hint>

      <button
        onClick={() => zoomTo(1, { duration: 200 })}
        className="min-w-[52px] rounded px-1 py-1 text-center text-xs font-medium tabular-nums text-neutral-700 hover:bg-neutral-100"
        title="Reset to 100%"
      >
        {Math.round(zoom * 100)}%
      </button>

      <Hint label="Zoom in" side="top" sideOffset={8}>
        <button
          onClick={() => zoomIn({ duration: 150 })}
          className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100"
        >
          <Plus className="h-4 w-4" />
        </button>
      </Hint>

      <span className="mx-0.5 h-5 w-px bg-neutral-200" />

      <Hint label="Fit to screen" side="top" sideOffset={8}>
        <button
          onClick={() => fitView({ duration: 300, padding: 0.15 })}
          className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </Hint>
    </div>
  );
};
