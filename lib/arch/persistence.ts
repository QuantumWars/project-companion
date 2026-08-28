"use client";

/**
 * Where a canvas reads and writes its document.
 *
 * There are two backings and they are not interchangeable in purpose:
 *
 * - `localStoragePersistence` -- the standalone browser playground. Fast, no
 *   server, but invisible to anything outside the tab.
 * - `filePersistence` -- the project's `.arch/` directory, reached through the
 *   local API route. This is the one a coding agent can also see, which is the
 *   whole point of the file format.
 *
 * `load` is async so the HTTP backing fits; the store hydrates when it resolves
 * rather than blocking the first paint.
 */

import type { ArchDocument } from "@/types/arch";
import { loadArchDocument, saveArchDocument } from "./storage";

export type ArchPersistence = {
  load: () => Promise<ArchDocument | null>;
  save: (doc: ArchDocument) => void;
  /**
   * Notifies when the document changed underneath us -- an agent editing the
   * file while the canvas is open. Returns an unsubscribe. Optional: a
   * localStorage board has no second writer.
   */
  watch?: (onChange: (doc: ArchDocument) => void) => () => void;
  /** Shown in the UI so it is never ambiguous which store you are editing. */
  kind: "local" | "file";
};

export const localStoragePersistence = (boardId: string): ArchPersistence => ({
  kind: "local",
  load: async () => loadArchDocument(boardId),
  save: (doc) => saveArchDocument(boardId, doc),
});

/**
 * @param root Absolute path of the project to read and write. Defaults to the
 *   project the app is running inside. Only roots in the global index are
 *   accepted by the API, so this cannot reach an arbitrary directory.
 */
export const filePersistence = (
  diagramId: string,
  root?: string,
): ArchPersistence => {
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  let inflight: Promise<void> | null = null;
  let queued: ArchDocument | null = null;
  /**
   * Fingerprint of the last document we either sent or read.
   *
   * Content rather than `updatedAt`: a person editing the JSON by hand does
   * not bump the timestamp, and a change we cannot see is worse than an
   * occasional redundant comparison. Diagrams are tens of nodes, so this is
   * cheap.
   */
  let seen: string | null = null;

  const fingerprint = (doc: {
    nodes: ArchDocument["nodes"];
    edges: ArchDocument["edges"];
    diagramType?: ArchDocument["diagramType"];
  }) => JSON.stringify([doc.nodes, doc.edges, doc.diagramType]);

  /**
   * Saves are coalesced: a drag produces a write every 150ms, and overlapping
   * PUTs to the same file could land out of order.
   */
  const flush = (): Promise<void> => {
    if (inflight) return inflight;

    const doc = queued;
    queued = null;
    if (!doc) return Promise.resolve();

    inflight = fetch(`/api/project/diagrams/${encodeURIComponent(diagramId)}${query}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // `diagramType` belongs here too: switching it in the pill is an edit to
      // the document, and leaving it out silently reverted on reload.
      body: JSON.stringify({
        nodes: doc.nodes,
        edges: doc.edges,
        viewport: doc.viewport,
        diagramType: doc.diagramType,
      }),
    })
      .then(() => {
        // Record our own write so the watcher does not mistake it for someone
        // else's and reload the canvas out from under the user.
        seen = fingerprint(doc);
      })
      .catch(() => {
        // A failed save must not wedge the queue; the next edit retries.
      })
      .then(() => {
        inflight = null;
        if (queued) void flush();
      });

    return inflight;
  };

  return {
    kind: "file",
    load: async () => {
      const res = await fetch(
        `/api/project/diagrams/${encodeURIComponent(diagramId)}${query}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;

      const file = (await res.json()) as {
        nodes: ArchDocument["nodes"];
        edges: ArchDocument["edges"];
        viewport?: ArchDocument["viewport"];
        type?: ArchDocument["diagramType"];
        updatedAt?: string;
      };

      const doc = {
        nodes: file.nodes ?? [],
        edges: file.edges ?? [],
        viewport: file.viewport ?? { x: 0, y: 0, zoom: 1 },
        diagramType: file.type ?? "architecture",
      };

      seen = fingerprint(doc);
      return doc;
    },

    watch: (onChange) => {
      let stopped = false;

      const poll = async () => {
        // A save in flight means our own newer version is not on the server
        // yet; adopting the older one would undo the edit being written.
        if (stopped || inflight) return;

        try {
          const res = await fetch(
            `/api/project/diagrams/${encodeURIComponent(diagramId)}${query}`,
            { cache: "no-store" },
          );
          if (!res.ok) return;

          const file = (await res.json()) as {
            nodes: ArchDocument["nodes"];
            edges: ArchDocument["edges"];
            viewport?: ArchDocument["viewport"];
            type?: ArchDocument["diagramType"];
          };

          const doc = {
            nodes: file.nodes ?? [],
            edges: file.edges ?? [],
            viewport: file.viewport ?? { x: 0, y: 0, zoom: 1 },
            diagramType: file.type ?? "architecture",
          };

          const next = fingerprint(doc);
          if (next === seen) return;

          seen = next;
          onChange(doc);
        } catch {
          // Offline or the dev server restarted; the next tick retries.
        }
      };

      // Focus covers the common case -- you were in the terminal while an
      // agent worked. The slow poll catches a side-by-side window.
      const onFocus = () => void poll();
      window.addEventListener("focus", onFocus);
      const timer = window.setInterval(poll, 4000);

      return () => {
        stopped = true;
        window.removeEventListener("focus", onFocus);
        window.clearInterval(timer);
      };
    },
    save: (doc) => {
      queued = doc;
      void flush();
    },
  };
};
