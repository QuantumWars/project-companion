"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CornerDownRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The affordance that makes a node a level rather than a box.
 *
 * C4's whole idea is that you read an architecture by zooming: a container
 * opens into its components, which open into code. `drilldownDiagramId` has
 * been on `ServiceData`, `GroupData` and `C4Data` since frames landed and was
 * referenced nowhere, so the field existed and the zoom did not.
 *
 * The target is built by swapping the last path segment rather than hardcoding
 * a route, because the same canvas is mounted at two of them -- `/arch/<id>`
 * for a scratch board and `/project/diagram/<id>` for one the agent can see --
 * and a node cannot know which it is inside. `?root=` is carried over, since
 * dropping it is how you end up looking at a different project's diagram.
 */
export const useDrilldown = (diagramId: string | undefined) => {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  return useCallback(
    (event?: { stopPropagation: () => void; preventDefault: () => void }) => {
      if (!diagramId) return;
      event?.stopPropagation();
      event?.preventDefault();

      const segments = pathname.split("/");
      segments[segments.length - 1] = encodeURIComponent(diagramId);
      const root = search.get("root");
      router.push(`${segments.join("/")}${root ? `?root=${encodeURIComponent(root)}` : ""}`);
    },
    [diagramId, pathname, router, search],
  );
};

/**
 * Shown only when there is somewhere to go.
 *
 * Deliberately not a whole-node click target: a node is also something you
 * select, drag and connect, and making the body navigate would make every
 * attempt to move a box a navigation instead.
 */
export const DrilldownBadge = ({
  diagramId,
  variant = "float",
  className,
}: {
  diagramId?: string;
  /**
   * `float` hangs off the bottom edge, which reads as "there is another level
   * below this". A group has no bottom edge worth hanging from -- it is a
   * region containing other nodes -- so it gets `inline`, in its header.
   */
  variant?: "float" | "inline";
  className?: string;
}) => {
  const open = useDrilldown(diagramId);
  if (!diagramId) return null;

  return (
    <button
      type="button"
      title="Open the diagram inside this"
      aria-label="Open the diagram inside this"
      onClick={open}
      className={cn(
        "nodrag flex items-center justify-center rounded-full border border-neutral-300",
        "bg-white text-neutral-500 shadow-sm transition-colors",
        "hover:border-blue-500 hover:text-blue-600",
        variant === "float"
          ? "absolute -bottom-2 left-1/2 h-5 w-5 -translate-x-1/2"
          : "h-4 w-4 shrink-0",
        className,
      )}
    >
      <CornerDownRight size={variant === "float" ? 11 : 9} />
    </button>
  );
};
