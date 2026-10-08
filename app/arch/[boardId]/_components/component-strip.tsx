"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Boxes, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/primitives";

/**
 * Turns the selected node into something a team owns, or opens what it already is.
 *
 * The one write the canvas needs that the CLI cannot stand in for. Somebody
 * looking at a diagram decides a box is real work; if saying so means leaving
 * for a terminal, the model stops being used and the catalog stays empty --
 * which is the failure every internal developer portal dies of.
 *
 * Positioned along the bottom rather than under the inspector, because the
 * inspectors are five different heights and anchoring to the shorter ones
 * leaves a gap while anchoring to the taller ones overlaps.
 */
export const ComponentStrip = ({
  diagramId,
  nodeId,
  componentId,
  label,
  onTracked,
}: {
  diagramId: string;
  nodeId: string;
  componentId?: string;
  label: string;
  onTracked: (componentId: string) => void;
}) => {
  const root = useSearchParams().get("root");
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A node can be tracked from elsewhere -- the CLI, an agent -- while this is
  // on screen, so the message clears when the selection moves.
  useEffect(() => setError(null), [nodeId]);

  const track = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/project/components${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ diagramId, nodeId, title: label }),
      });
      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "Could not track this node.");
      onTracked(body.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-x-2 rounded-full border border-line bg-panel px-2 py-1.5 shadow-lg">
      <Boxes className="ml-1 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      {componentId ? (
        <>
          <span className="text-xs text-fg-muted">
            Tracked as <span className="text-fg">{componentId}</span>
          </span>
          <Link
            href={`/project/node/${componentId}${query}`}
            className="rounded-full bg-brand px-2.5 py-1 text-xs font-medium text-brand-fg hover:bg-brand-hover"
          >
            Open
          </Link>
        </>
      ) : (
        <>
          <span className="text-xs text-fg-muted">
            {error ?? "Not tracked. Nothing attributes to this node."}
          </span>
          <Button size="sm" variant="secondary" onClick={track} disabled={busy}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Track it
          </Button>
        </>
      )}
    </div>
  );
};
