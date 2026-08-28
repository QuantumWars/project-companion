"use client";

import { useEffect, useState } from "react";

/**
 * Says which store the board on screen is being written to.
 *
 * The two are not interchangeable -- a localStorage board is invisible to a
 * coding agent -- so the difference has to be visible rather than inferred
 * from the URL. The label is read from the API instead of hardcoded, because
 * the store can be moved between agent directories.
 */
export const StoreBadge = () => {
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/project")
      .then((r) => r.json())
      .then((p: { storeDir?: string | null }) => setDir(p.storeDir ?? null))
      .catch(() => {});
  }, []);

  // The agent directory alone: ".claude" reads better than ".claude/project-companion".
  const label = dir ? dir.split("/")[0] : "project";

  return (
    <span
      title={dir ? `Stored in ${dir}` : undefined}
      className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700"
    >
      {label}
    </span>
  );
};
