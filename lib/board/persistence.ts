"use client";

/**
 * Where a whiteboard reads and writes its layers.
 *
 * Same split as the architecture canvas: the standalone browser playground
 * stays on localStorage, while a project board goes through the local API into
 * the repository's store, which is the copy a coding agent can see.
 *
 * `load` is async so the HTTP backing fits; the room hydrates when it resolves.
 */

import type { Layer } from "@/types/canvas";

export type BoardDocument = {
  layerIds: string[];
  layers: [string, Layer][];
};

export type BoardPersistence = {
  load: () => Promise<BoardDocument | null>;
  save: (doc: BoardDocument) => void;
  /** Notifies when the file changed underneath us. See the arch equivalent. */
  watch?: (onChange: (doc: BoardDocument) => void) => () => void;
  kind: "local" | "file";
};

export const BOARD_STORAGE_PREFIX = "miro-clone:room:";

const isBrowser = typeof window !== "undefined";

export const localBoardPersistence = (boardId: string): BoardPersistence => ({
  kind: "local",
  load: async () => {
    if (!isBrowser) return null;
    try {
      const raw = window.localStorage.getItem(`${BOARD_STORAGE_PREFIX}${boardId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as BoardDocument;
      return Array.isArray(parsed?.layerIds) && Array.isArray(parsed?.layers)
        ? parsed
        : null;
    } catch {
      return null;
    }
  },
  save: (doc) => {
    if (!isBrowser) return;
    try {
      window.localStorage.setItem(
        `${BOARD_STORAGE_PREFIX}${boardId}`,
        JSON.stringify(doc),
      );
    } catch {
      // Quota or private-mode failures shouldn't take the canvas down.
    }
  },
});

/** @param root See `lib/arch/persistence`. */
export const fileBoardPersistence = (
  boardId: string,
  root?: string,
): BoardPersistence => {
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  let inflight: Promise<void> | null = null;
  let queued: BoardDocument | null = null;
  /** Content of the last document we sent or read. See `lib/arch/persistence`. */
  let seen: string | null = null;

  const fingerprint = (doc: BoardDocument) =>
    JSON.stringify([doc.layerIds, doc.layers]);

  /** Coalesced: drawing writes constantly and PUTs could otherwise reorder. */
  const flush = (): Promise<void> => {
    if (inflight) return inflight;

    const doc = queued;
    queued = null;
    if (!doc) return Promise.resolve();

    inflight = fetch(`/api/project/boards/${encodeURIComponent(boardId)}${query}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    })
      .then(() => {
        seen = fingerprint(doc);
      })
      .catch(() => {})
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
        `/api/project/boards/${encodeURIComponent(boardId)}${query}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;

      const file = (await res.json()) as BoardDocument;
      const doc = { layerIds: file.layerIds ?? [], layers: file.layers ?? [] };
      seen = fingerprint(doc);
      return doc;
    },

    watch: (onChange) => {
      let stopped = false;

      const poll = async () => {
        if (stopped || inflight) return;

        try {
          const res = await fetch(
            `/api/project/boards/${encodeURIComponent(boardId)}${query}`,
            { cache: "no-store" },
          );
          if (!res.ok) return;

          const file = (await res.json()) as BoardDocument;
          const doc = { layerIds: file.layerIds ?? [], layers: file.layers ?? [] };

          const next = fingerprint(doc);
          if (next === seen) return;

          seen = next;
          onChange(doc);
        } catch {
          // Offline or the dev server restarted; the next tick retries.
        }
      };

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
