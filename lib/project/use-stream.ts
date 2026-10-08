"use client";

import { useEffect, useRef, useState } from "react";

export type Signal = "project" | "log" | "prd" | "git";

/**
 * Runs `onChange` when something in the project moves.
 *
 * The contract that matters is the return value: `live` says whether the stream
 * is actually connected. Callers keep their existing poll and skip a tick while
 * `live` is true, so a stream that fails -- an old build, a proxy that buffers,
 * a browser with EventSource disabled -- degrades to exactly the behaviour that
 * was there before rather than to a page that never updates.
 *
 * The handler is held in a ref so a caller can pass an inline arrow without
 * tearing down and rebuilding the connection on every render, which is the
 * usual way this hook shape ends up reconnecting in a loop.
 */
export const useProjectStream = (
  onChange: (signals: Signal[]) => void,
  options: { root?: string; only?: Signal[] } = {},
): { live: boolean } => {
  const [live, setLive] = useState(false);
  const handler = useRef(onChange);
  handler.current = onChange;

  const only = options.only?.join(",");
  const root = options.root;

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const query = root ? `?root=${encodeURIComponent(root)}` : "";
    const source = new EventSource(`/api/project/stream${query}`);
    const wanted = only?.split(",") as Signal[] | undefined;

    source.addEventListener("open", () => setLive(true));
    source.addEventListener("changed", (event) => {
      try {
        const { signals } = JSON.parse((event as MessageEvent).data) as { signals: Signal[] };
        const relevant = wanted ? signals.filter((s) => wanted.includes(s)) : signals;
        if (relevant.length) handler.current(relevant);
      } catch {
        // A frame we cannot read is not a reason to tear down the connection.
      }
    });

    // The browser reconnects on its own; what it cannot do is tell the page it
    // is currently disconnected, and that is what the fallback poll needs.
    source.onerror = () => setLive(false);

    return () => {
      source.close();
      setLive(false);
    };
  }, [root, only]);

  return { live };
};
