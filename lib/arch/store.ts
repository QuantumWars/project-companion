"use client";

/**
 * State for one architecture board.
 *
 * React Flow already owns an internal zustand store for viewport and
 * interaction state, so this one deliberately owns only the *document* --
 * nodes, edges, viewport -- and hands it down as controlled props.
 *
 * History mirrors the semantics of the whiteboard's `LocalRoom` shim rather
 * than inventing new ones: snapshot-based undo/redo capped at `MAX_HISTORY`,
 * with `pause()`/`resume()` collapsing a burst of changes into a single entry.
 * That matters here because React Flow fires `onNodesChange` on every pointer
 * move during a drag; pausing on drag start and resuming on drag stop is what
 * turns a drag into one undo step instead of hundreds.
 *
 * Persistence is the same shape too: debounced writes plus a `pagehide` flush,
 * keyed by board id alongside `miro-clone:room:*`.
 */

import { createContext, useContext } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";

import {
  emptyArchDocument,
  type ArchDocument,
  type DiagramType,
  type ArchEdge,
  type ArchNode,
  type ShapeData,
  type Viewport,
} from "@/types/arch";

import { getGeometry } from "./shapes";
import { onArchStorageCleared } from "./storage";
import { localStoragePersistence, type ArchPersistence } from "./persistence";

const MAX_HISTORY = 100;
const PERSIST_DEBOUNCE_MS = 150;

const isBrowser = typeof window !== "undefined";

type Snapshot = {
  nodes: ArchNode[];
  edges: ArchEdge[];
};

export type ArchState = {
  nodes: ArchNode[];
  edges: ArchEdge[];
  viewport: Viewport;
  diagramType: DiagramType;

  canUndo: boolean;
  canRedo: boolean;

  onNodesChange: (changes: NodeChange<ArchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<ArchEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  setViewport: (viewport: Viewport) => void;
  setDiagramType: (diagramType: DiagramType) => void;

  addNode: (node: ArchNode) => void;
  setNodes: (nodes: ArchNode[]) => void;
  reparentNode: (
    id: string,
    parentId: string | undefined,
    position: { x: number; y: number },
  ) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  deleteSelected: () => void;
  replaceGraph: (nodes: ArchNode[], edges: ArchEdge[]) => void;

  undo: () => void;
  redo: () => void;
  pause: () => void;
  resume: () => void;
};

export type ArchStore = StoreApi<ArchState>;

/* ------------------------------ persistence ------------------------------ */

/**
 * React Flow requires a parent to appear before its children in the nodes
 * array, otherwise a container paints over the nodes inside it. A depth-first
 * walk from the roots gives that ordering and also drops any node orphaned by
 * a deleted parent.
 */
/**
 * Gives a shape node its geometry's default size when the document omits one.
 *
 * React Flow hides a node until it has measured a box, and a shape whose
 * wrapper has no dimensions measures 0x0 and stays hidden -- rendering nothing,
 * silently, with no error. Both creation paths set a size today, so this
 * guards documents that did not come from them: a hand-edited file, an older
 * board, or an importer yet to be written.
 */
const withMeasurableSizes = (nodes: ArchNode[]): ArchNode[] =>
  nodes.map((node) => {
    if (node.type !== "shape" || (node.width && node.height)) {
      return node;
    }
    const { defaultSize } = getGeometry((node.data as ShapeData).geometry);
    return {
      ...node,
      width: node.width ?? defaultSize.w,
      height: node.height ?? defaultSize.h,
    };
  });

export const sortByHierarchy = (nodes: ArchNode[]): ArchNode[] => {
  const children = new Map<string | undefined, ArchNode[]>();
  const ids = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    // A parent that no longer exists would strand the child off-screen.
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }

  const out: ArchNode[] = [];
  const walk = (parent: string | undefined) => {
    for (const node of children.get(parent) ?? []) {
      out.push(node);
      walk(node.id);
    }
  };
  walk(undefined);

  return out;
};

/** Absolute position of every node, walking up the parent chain. */
const absolutePositions = (nodes: ArchNode[]): Map<string, { x: number; y: number }> => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cache = new Map<string, { x: number; y: number }>();

  const resolve = (node: ArchNode): { x: number; y: number } => {
    const hit = cache.get(node.id);
    if (hit) return hit;

    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const base = parent ? resolve(parent) : { x: 0, y: 0 };
    const abs = { x: base.x + node.position.x, y: base.y + node.position.y };

    cache.set(node.id, abs);
    return abs;
  };

  for (const node of nodes) resolve(node);
  return cache;
};

/**
 * Frees nodes whose parent no longer exists, converting their parent-relative
 * position back to an absolute one. Without this a deleted container would drag
 * its children to the origin, because their coordinates were relative to it.
 */
const promoteOrphans = (nodes: ArchNode[], before: ArchNode[]): ArchNode[] => {
  const alive = new Set(nodes.map((n) => n.id));
  if (nodes.every((n) => !n.parentId || alive.has(n.parentId))) {
    return nodes;
  }

  const absolute = absolutePositions(before);

  return nodes.map((node) =>
    node.parentId && !alive.has(node.parentId)
      ? ({
          ...node,
          parentId: undefined,
          extent: undefined,
          position: absolute.get(node.id) ?? node.position,
        } as ArchNode)
      : node,
  );
};

/**
 * `selected` and `dragging` are interaction state, not document state -- a
 * reload should not restore a mid-drag node or a stale selection.
 */
const stripTransient = (nodes: ArchNode[]): ArchNode[] =>
  nodes.map(({ selected: _selected, dragging: _dragging, ...node }) => node);

/* -------------------------------- factory -------------------------------- */

const createArchStore = (
  boardId: string,
  persistence: ArchPersistence,
): ArchStore => {
  // The document starts empty and hydrates when `load` resolves, so an async
  // backing (the file store, over HTTP) does not block the first paint.
  const initial = emptyArchDocument();

  let undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let pauseDepth = 0;
  let pausedSnapshot: Snapshot | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const store = createStore<ArchState>()((set, get) => {
    const snapshot = (): Snapshot => {
      const { nodes, edges } = get();
      return { nodes, edges };
    };

    const persist = () => {
      if (!isBrowser) {
        return;
      }

      const { nodes, edges, viewport, diagramType } = get();
      const payload: ArchDocument = {
        nodes: stripTransient(nodes),
        edges,
        viewport,
        diagramType,
      };
      persistence.save(payload);
    };

    /** Dragging fires a change per pointer move; don't serialise on each one. */
    const schedulePersist = () => {
      if (!isBrowser || persistTimer !== null) {
        return;
      }

      persistTimer = setTimeout(() => {
        persistTimer = null;
        persist();
      }, PERSIST_DEBOUNCE_MS);
    };

    const persistNow = () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }

      persist();
    };

    const record = (before: Snapshot) => {
      // While paused every change collapses into the single entry captured at
      // `pause()`, which is what makes a drag one undo step.
      if (pauseDepth > 0) {
        return;
      }

      undoStack.push(before);
      if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
      }
      redoStack = [];

      set({ canUndo: true, canRedo: false });
    };

    /** Applies a document mutation, recording history and scheduling a write. */
    const mutate = (next: Partial<Snapshot>) => {
      const before = snapshot();
      set(next);
      record(before);
      schedulePersist();
    };

    const restore = (entry: Snapshot) => {
      set({ nodes: entry.nodes, edges: entry.edges });
      set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
      persistNow();
    };

    if (isBrowser) {
      window.addEventListener("pagehide", persistNow);

      // Hydration replaces the empty document without touching history: the
      // initial load is not an edit and must not be undoable.
      void persistence.load().then((doc) => {
        if (!doc) return;
        set({
          nodes: withMeasurableSizes(doc.nodes),
          edges: doc.edges,
          viewport: doc.viewport,
          diagramType: doc.diagramType ?? "architecture",
        });
      });

      // Someone else -- an agent, or another window -- changed the document.
      // Adopt it, but keep the viewport: yanking the camera while the user is
      // looking at something is worse than a slightly stale frame.
      persistence.watch?.((doc) => {
        set({
          nodes: withMeasurableSizes(doc.nodes),
          edges: doc.edges,
          diagramType: doc.diagramType ?? get().diagramType,
        });
      });
    }

    return {
      nodes: initial.nodes,
      edges: initial.edges,
      viewport: initial.viewport,
      diagramType: initial.diagramType ?? "architecture",

      canUndo: false,
      canRedo: false,

      onNodesChange: (changes) => {
        // Dimension changes are React Flow measuring the DOM, and selection is
        // interaction state. Neither is a document edit, so neither should
        // land on the undo stack or trigger a write.
        const isDocumentEdit = changes.some(
          (change) =>
            change.type !== "dimensions" && change.type !== "select",
        );

        const before = get().nodes;
        const next = applyNodeChanges(changes, before);

        if (isDocumentEdit) {
          // Backspace-delete also lands here, so orphans have to be handled on
          // this path too, not just in `deleteSelected`.
          const removed = changes.some((change) => change.type === "remove");
          mutate({
            nodes: removed
              ? sortByHierarchy(promoteOrphans(next, before))
              : next,
          });
        } else {
          set({ nodes: next });
        }
      },

      onEdgesChange: (changes) => {
        const isDocumentEdit = changes.some(
          (change) => change.type !== "select",
        );

        const next = applyEdgeChanges(changes, get().edges);

        if (isDocumentEdit) {
          mutate({ edges: next });
        } else {
          set({ edges: next });
        }
      },

      onConnect: (connection) => {
        mutate({
          edges: addEdge(
            {
              ...connection,
              type: "flow",
              data: { kind: "flow", arrowEnd: true },
            },
            get().edges,
          ) as ArchEdge[],
        });
      },

      // The viewport is not a document edit: panning shouldn't be undoable,
      // but it should survive a reload.
      setViewport: (viewport) => {
        set({ viewport });
        schedulePersist();
      },

      setDiagramType: (diagramType) => {
        set({ diagramType });
        schedulePersist();
      },

      addNode: (node) => {
        mutate({ nodes: sortByHierarchy([...get().nodes, node]) });
      },

      /** Used by auto-layout, which returns every node repositioned at once. */
      setNodes: (nodes) => {
        mutate({ nodes: sortByHierarchy(nodes) });
      },

      reparentNode: (id, parentId, position) => {
        mutate({
          nodes: sortByHierarchy(
            get().nodes.map((node) =>
              node.id === id
                ? ({
                    ...node,
                    parentId,
                    // Only a node inside a container is clipped to it.
                    extent: parentId ? ("parent" as const) : undefined,
                    position,
                  } as ArchNode)
                : node,
            ),
          ),
        });
      },

      updateNodeData: (id, patch) => {
        mutate({
          nodes: get().nodes.map((node) =>
            node.id === id
              ? ({ ...node, data: { ...node.data, ...patch } } as ArchNode)
              : node,
          ),
        });
      },

      deleteSelected: () => {
        const doomed = new Set(
          get()
            .nodes.filter((node) => node.selected)
            .map((node) => node.id),
        );

        const before = get().nodes;
        const nodes = sortByHierarchy(
          promoteOrphans(
            before.filter((node) => !doomed.has(node.id)),
            before,
          ),
        );
        const edges = get().edges.filter(
          (edge) =>
            !edge.selected &&
            !doomed.has(edge.source) &&
            !doomed.has(edge.target),
        );

        if (nodes.length === get().nodes.length && edges.length === get().edges.length) {
          return;
        }

        mutate({ nodes, edges });
      },

      replaceGraph: (nodes, edges) => {
        mutate({ nodes: sortByHierarchy(nodes), edges });
      },

      undo: () => {
        const entry = undoStack.pop();
        if (!entry) {
          return;
        }

        redoStack.push(snapshot());
        restore(entry);
      },

      redo: () => {
        const entry = redoStack.pop();
        if (!entry) {
          return;
        }

        undoStack.push(snapshot());
        restore(entry);
      },

      pause: () => {
        if (pauseDepth === 0) {
          pausedSnapshot = snapshot();
        }
        pauseDepth++;
      },

      resume: () => {
        // `resume()` is called on every drag stop, including ones that never
        // paused, so an unmatched call has to be a no-op rather than go
        // negative.
        if (pauseDepth === 0) {
          return;
        }

        pauseDepth--;
        if (pauseDepth > 0) {
          return;
        }

        const paused = pausedSnapshot;
        pausedSnapshot = null;

        if (!paused) {
          return;
        }

        const current = snapshot();
        if (paused.nodes === current.nodes && paused.edges === current.edges) {
          return;
        }

        undoStack.push(paused);
        if (undoStack.length > MAX_HISTORY) {
          undoStack.shift();
        }
        redoStack = [];

        set({ canUndo: true, canRedo: false });
        persistNow();
      },
    };
  });

  return store;
};

/* --------------------------------- access -------------------------------- */

const stores = new Map<string, ArchStore>();

// A deleted board must not leave a live store behind for a recycled id.
onArchStorageCleared((boardId) => void stores.delete(boardId));

export { clearArchStorage } from "./storage";

export const getArchStore = (
  boardId: string,
  persistence: ArchPersistence = localStoragePersistence(boardId),
): ArchStore => {
  // Stores are only cached in the browser; on the server every render gets a
  // throwaway empty one so requests can't leak state into each other.
  if (!isBrowser) {
    return createArchStore(boardId, persistence);
  }

  // Keyed by backing as well as id: `/arch/x` and the file-backed `/project/x`
  // are different documents and must not share one store.
  const key = `${persistence.kind}:${boardId}`;
  const existing = stores.get(key);
  if (existing) {
    return existing;
  }

  const store = createArchStore(boardId, persistence);
  stores.set(key, store);
  return store;
};

export const ArchStoreContext = createContext<ArchStore | null>(null);

export const useArchStoreApi = (): ArchStore => {
  const store = useContext(ArchStoreContext);

  if (!store) {
    throw new Error("useArchStore() must be used inside an <ArchProvider />");
  }

  return store;
};
