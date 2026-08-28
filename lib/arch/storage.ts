"use client";

/**
 * localStorage layer for architecture boards.
 *
 * Deliberately free of any *value* import from `@xyflow/react` -- only erased
 * `import type`s. `lib/local-boards.ts` calls `clearArchStorage` when deleting
 * a board, and it is imported by the dashboard and the whiteboard; pulling
 * this from `store.ts` instead would drag React Flow's runtime into both of
 * those bundles.
 */

import { emptyArchDocument, type ArchDocument } from "@/types/arch";

const STORAGE_PREFIX = "miro-clone:arch:";

const isBrowser = typeof window !== "undefined";

const storageKey = (boardId: string) => `${STORAGE_PREFIX}${boardId}`;

export const loadArchDocument = (boardId: string): ArchDocument | null => {
  if (!isBrowser) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey(boardId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as ArchDocument;
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) {
      return null;
    }

    return {
      nodes: parsed.nodes,
      edges: parsed.edges,
      viewport: parsed.viewport ?? emptyArchDocument().viewport,
      diagramType: parsed.diagramType ?? "architecture",
    };
  } catch {
    return null;
  }
};

export const saveArchDocument = (boardId: string, doc: ArchDocument) => {
  if (!isBrowser) {
    return;
  }

  try {
    window.localStorage.setItem(storageKey(boardId), JSON.stringify(doc));
  } catch {
    // Quota or private-mode failures shouldn't take the canvas down.
  }
};

/**
 * Store instances register here so a delete can evict their in-memory cache.
 * When only the dashboard is loaded this set is empty and clearing is a plain
 * localStorage removal -- which is exactly the point.
 */
const evictionListeners = new Set<(boardId: string) => void>();

export const onArchStorageCleared = (listener: (boardId: string) => void) => {
  evictionListeners.add(listener);
  return () => void evictionListeners.delete(listener);
};

/** Wipes a board's persisted graph. Called when a board is deleted. */
export const clearArchStorage = (boardId: string) => {
  evictionListeners.forEach((listener) => listener(boardId));

  if (!isBrowser) {
    return;
  }

  try {
    window.localStorage.removeItem(storageKey(boardId));
  } catch {
    // ignore
  }
};
