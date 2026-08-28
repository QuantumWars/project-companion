"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PrdOp } from "./prd";
import type { Feature, Phase, Task } from "./types";

export type RoadmapView = {
  configured: boolean;
  present: boolean;
  source: string;
  sourceHash: string;
  title?: string;
  phases: Phase[];
  features: Feature[];
  orphans: Feature[];
  warnings: string[];
  tasksByFeature: Record<string, Task[]>;
};

const EMPTY: RoadmapView = {
  configured: false,
  present: false,
  source: "docs/prd.md",
  sourceHash: "",
  phases: [],
  features: [],
  orphans: [],
  warnings: [],
  tasksByFeature: {},
};

export type Conflict = { featureId?: string; message: string };

/**
 * The roadmap, kept in step with a file two people are editing.
 *
 * The agent edits `docs/prd.md` in the terminal while this page is open, so a
 * write is a compare-and-swap on the document's hash. When that fails, what
 * happens next depends on whether the agent touched the thing being edited:
 * an unrelated change is adopted silently and the edit retried, while a
 * collision on the same feature is surfaced rather than merged.
 */
export const useRoadmap = (root?: string) => {
  const [view, setView] = useState<RoadmapView>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const inflight = useRef(false);
  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/project/roadmap${query}`);
    const data = (await response.json()) as RoadmapView;
    setView({ ...EMPTY, ...data });
    setLoading(false);
    return data;
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only for the hash, so a quiet page costs almost nothing. Skipped while
  // a write is in flight, and while the tab is hidden.
  useEffect(() => {
    const check = async () => {
      if (inflight.current || document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/project/roadmap${query}${query ? "&" : "?"}hash=1`);
        const data = (await response.json()) as { sourceHash?: string };
        if (data.sourceHash && data.sourceHash !== view.sourceHash) void refresh();
      } catch {
        // A failed poll is not worth surfacing; the next one will retry.
      }
    };

    const timer = setInterval(check, 4000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [query, refresh, view.sourceHash]);

  const apply = useCallback(
    async (ops: PrdOp[], options: { retryOnConflict?: boolean } = {}): Promise<boolean> => {
      inflight.current = true;
      try {
        const send = async (baseHash: string) =>
          fetch(`/api/project/roadmap${query}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseHash, ops }),
          });

        let response = await send(view.sourceHash);

        if (response.status === 409) {
          const fresh = (await response.json()) as RoadmapView & { error: string };
          setView({ ...EMPTY, ...fresh });

          // Retry once against the fresh document, but only for edits that
          // still mean the same thing against changed text. A title is an
          // overwrite, so it is never retried blindly.
          const retryable =
            options.retryOnConflict !== false && ops.every((op) => op.op !== "setTitle");

          if (!retryable) {
            setConflict({
              message: "The PRD changed on disk while you were editing.",
              featureId: ops.flatMap((op) => ("featureId" in op ? [op.featureId] : []))[0],
            });
            return false;
          }

          response = await send(fresh.sourceHash);
        }

        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          setConflict({ message: data.error ?? "The edit could not be applied." });
          return false;
        }

        const data = (await response.json()) as RoadmapView;
        setView({ ...EMPTY, ...data });
        setConflict(null);
        return true;
      } finally {
        inflight.current = false;
      }
    },
    [query, view.sourceHash],
  );

  return { ...view, loading, conflict, dismissConflict: () => setConflict(null), refresh, apply };
};
