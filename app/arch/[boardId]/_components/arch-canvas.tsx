"use client";

// Scoped to this route's chunk on purpose -- importing it from `globals.css`
// would ship React Flow's stylesheet to the whiteboard too.
import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";

import { ArchProvider, useArchStore } from "@/lib/arch/provider";
import { NodeTasksProvider } from "@/lib/project/task-context";
import { EdgeLabelProvider } from "@/lib/arch/edge-labels";
import {
  filePersistence,
  localStoragePersistence,
} from "@/lib/arch/persistence";
import { getTech } from "@/lib/arch/tech-catalog";
import {
  algorithmFor,
  layoutGraph,
  overrideForDiagramType,
  type LayoutOverride,
} from "@/lib/arch/layout";
import type { Geometry } from "@/lib/arch/shapes";
import type { SpecialNode } from "./node-palette";
import type { ImportResult } from "@/lib/arch/import/types";
import { useArchStoreApi } from "@/lib/arch/store";
import type { ArchEdge, ArchNode, DiagramType } from "@/types/arch";

import type { GroupData, ServiceData, ShapeData } from "@/types/arch";
import type { TechDef } from "@/lib/arch/tech-catalog";

import { Topbar } from "./topbar";
import { ZoomControls } from "./zoom-controls";
import { Toolbar } from "./toolbar";
import { Inspector } from "./inspector";
import { NodePalette } from "./node-palette";
import { FlowEdge } from "./edges/flow-edge";
import { ErMarkers } from "./markers";
import { ImportDialog } from "./import-dialog";
import { GroupNode } from "./nodes/group-node";
import { ShapeNode } from "./nodes/shape-node";
import { TableNode } from "./nodes/table-node";
import { UmlClassNode } from "./nodes/uml-class-node";
import { RelationEdge } from "./edges/relation-edge";
import { ServiceNode } from "./nodes/service-node";
import { ComponentStrip } from "./component-strip";
import { C4Node } from "./nodes/c4-node";
import { NoteNode } from "./nodes/note-node";

// These must be module-level constants. A fresh object literal on each render
// makes React Flow tear down and remount every node.
const nodeTypes: NodeTypes = {
  service: ServiceNode,
  group: GroupNode,
  table: TableNode,
  c4: C4Node,
  note: NoteNode,
  shape: ShapeNode,
  umlclass: UmlClassNode,
};
const edgeTypes: EdgeTypes = { flow: FlowEdge, relation: RelationEdge };

/** Diagonal offset used when a new node would land on an existing one. */
const CASCADE_STEP = 36;

interface FlowProps {
  boardId: string;
  source: "local" | "file";
}

const Flow = ({ boardId, source }: FlowProps) => {
  const store = useArchStoreApi();
  const { screenToFlowPosition, getIntersectingNodes, getInternalNode, fitView } =
    useReactFlow();

  const nodes = useArchStore((state) => state.nodes);
  const edges = useArchStore((state) => state.edges);
  const diagramType = useArchStore((state) => state.diagramType);
  const canUndo = useArchStore((state) => state.canUndo);
  const canRedo = useArchStore((state) => state.canRedo);
  const hasSelection = useArchStore(
    (state) =>
      state.nodes.some((node) => node.selected) ||
      state.edges.some((edge) => edge.selected),
  );

  const [paletteMode, setPaletteMode] = useState<null | "add" | "replace">(null);
  const [isLayingOut, setIsLayingOut] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Exactly one selected node drives the inspector; a multi-selection has no
  // single set of properties to show.
  const selectedNode = useArchStore((state) => {
    const selected = state.nodes.filter((node) => node.selected);
    return selected.length === 1 ? selected[0] : null;
  });

  // Read once: feeding the live viewport back into `defaultViewport` would
  // fight the user's own panning.
  const initialViewport = useRef(store.getState().viewport).current;

  const addTech = useCallback((tech: TechDef) => {
    const centre = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });

    // Dropping every node on the exact centre stacks them into one pile, so
    // cascade off any node already sitting there until the spot is free.
    const existing = store.getState().nodes;
    const position = { ...centre };
    while (
      existing.some(
        (node) =>
          Math.abs(node.position.x - position.x) < CASCADE_STEP &&
          Math.abs(node.position.y - position.y) < CASCADE_STEP,
      )
    ) {
      position.x += CASCADE_STEP;
      position.y += CASCADE_STEP;
    }

    const node: ArchNode = {
      id: nanoid(),
      type: "service",
      position,
      data: { kind: "service", label: tech.label, tech: tech.id },
    };

    store.getState().addNode(node);
  }, [screenToFlowPosition, store]);

  const addContainer = useCallback(
    (data: GroupData, size: { width: number; height: number }) => {
      const centre = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });

      store.getState().addNode({
        id: nanoid(),
        type: "group",
        position: { x: centre.x - size.width / 2, y: centre.y - size.height / 2 },
        ...size,
        data,
      });
    },
    [screenToFlowPosition, store],
  );

  const addGroup = useCallback(
    () =>
      addContainer(
        { kind: "group", label: "Boundary", variant: "boundary" } satisfies GroupData,
        { width: 360, height: 240 },
      ),
    [addContainer],
  );

  /**
   * A frame is a diagram-within-the-canvas. It starts as whatever the board
   * currently is, which is the type someone was already thinking in -- they can
   * change it in the inspector.
   */
  const addFrame = useCallback(
    () =>
      addContainer(
        {
          kind: "group",
          label: "Frame",
          variant: "frame",
          diagramType,
        } satisfies GroupData,
        { width: 520, height: 380 },
      ),
    [addContainer, diagramType],
  );

  /**
   * Layout overrides for every frame on the canvas.
   *
   * Without this a board holding an ER frame and an org-chart frame runs one
   * algorithm over both and merges them into a single flow.
   */
  /**
   * The diagram type the palette should lead with.
   *
   * If the selection sits inside a frame, that frame's type wins -- someone
   * working in an ER frame wants table shapes first, whatever the board says.
   * Walks up the parent chain so a node nested two containers deep still finds
   * the frame that owns it.
   */
  const activeDiagramType = useMemo((): DiagramType => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let cursor: ArchNode | undefined = selectedNode ?? undefined;

    while (cursor) {
      const data = cursor.data as GroupData;
      if (data?.kind === "group" && data.variant === "frame" && data.diagramType) {
        return data.diagramType;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }

    return diagramType;
  }, [diagramType, nodes, selectedNode]);

  const frameOverrides = useCallback((): Map<string, LayoutOverride> => {
    const overrides = new Map<string, LayoutOverride>();
    for (const node of store.getState().nodes) {
      const data = node.data as GroupData;
      if (data?.kind === "group" && data.variant === "frame" && data.diagramType) {
        overrides.set(node.id, overrideForDiagramType(data.diagramType));
      }
    }
    return overrides;
  }, [store]);

  /**
   * Dropping a node onto a container nests it. React Flow does not do this on
   * its own -- the intersection test and the absolute-to-relative position
   * conversion are ours.
   */
  const onNodeDragStop = useCallback((_: unknown, dragged: ArchNode) => {
    store.getState().resume();

    const groups = getIntersectingNodes(dragged).filter(
      (candidate) => candidate.type === "group" && candidate.id !== dragged.id,
    );

    // Innermost wins, so dropping into a subnet inside a VPC picks the subnet.
    const target = groups.sort((a, b) => {
      const area = (n: typeof a) =>
        (n.measured?.width ?? 0) * (n.measured?.height ?? 0);
      return area(a) - area(b);
    })[0];

    const nextParent = target?.id;
    if (nextParent === (dragged.parentId ?? undefined)) {
      return;
    }

    // Never nest a container inside its own descendant.
    if (dragged.type === "group" && nextParent) {
      let walk = target as { id: string; parentId?: string } | undefined;
      while (walk) {
        if (walk.id === dragged.id) return;
        const parentId: string | undefined = walk.parentId;
        walk = parentId
          ? (store.getState().nodes.find((n) => n.id === parentId) as typeof walk)
          : undefined;
      }
    }

    const draggedAbs =
      getInternalNode(dragged.id)?.internals.positionAbsolute ?? dragged.position;
    const parentAbs = nextParent
      ? getInternalNode(nextParent)?.internals.positionAbsolute ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };

    store.getState().reparentNode(dragged.id, nextParent, {
      x: draggedAbs.x - parentAbs.x,
      y: draggedAbs.y - parentAbs.y,
    });
  }, [getInternalNode, getIntersectingNodes, store]);

  /**
   * React Flow deletes a container's children along with it. For an
   * architecture boundary that is the wrong default -- removing the grouping
   * should keep the services inside it -- so the deletion set is narrowed to
   * what the user actually selected, and the store then promotes the orphans.
   */
  const onBeforeDelete = useCallback(
    async ({ nodes: doomed, edges: doomedEdges }: {
      nodes: ArchNode[];
      edges: ArchEdge[];
    }) => {
      const selected = doomed.filter((node) => node.selected);
      return { nodes: selected.length ? selected : doomed, edges: doomedEdges };
    },
    [],
  );

  const onTidyUp = useCallback(async () => {
    const { nodes: current, edges: currentEdges } = store.getState();
    if (current.length === 0) {
      return;
    }

    setIsLayingOut(true);
    try {
      const laid = await layoutGraph(
        current,
        currentEdges,
        diagramType === "orgchart" || diagramType === "sitemap" ? "DOWN" : "RIGHT",
        algorithmFor(diagramType),
        frameOverrides(),
      );
      store.getState().setNodes(laid);
      // Let React Flow apply the new positions before framing them.
      window.setTimeout(() => fitView({ duration: 400, padding: 0.15 }), 60);
    } finally {
      setIsLayingOut(false);
    }
  }, [diagramType, fitView, frameOverrides, store]);

  /**
   * An imported schema replaces the board and is laid out immediately -- the
   * parsers return unpositioned nodes, so without this everything would stack
   * at the origin.
   */
  const onImport = useCallback(async (result: ImportResult) => {
    store.getState().replaceGraph(result.nodes, result.edges);
    setIsLayingOut(true);
    try {
      // Give React Flow a frame to mount and measure the new table nodes;
      // their height depends on the column count, so layout before measurement
      // would overlap them.
      await new Promise((r) => window.setTimeout(r, 120));
      const { nodes: mounted, edges: mountedEdges } = store.getState();
      const laid = await layoutGraph(
        mounted,
        mountedEdges,
        diagramType === "orgchart" || diagramType === "sitemap" ? "DOWN" : "RIGHT",
        algorithmFor(diagramType),
      );
      store.getState().setNodes(laid);
      window.setTimeout(() => fitView({ duration: 400, padding: 0.15 }), 60);
    } finally {
      setIsLayingOut(false);
    }
  }, [diagramType, fitView, store]);

  const onPickShape = useCallback((geometry: Geometry) => {
    const centre = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });

    store.getState().addNode({
      id: nanoid(),
      type: "shape",
      position: {
        x: centre.x - geometry.defaultSize.w / 2,
        y: centre.y - geometry.defaultSize.h / 2,
      },
      width: geometry.defaultSize.w,
      height: geometry.defaultSize.h,
      data: {
        kind: "shape",
        label: geometry.label,
        geometry: geometry.id,
        translucent: geometry.translucent,
      } satisfies ShapeData,
    });

    setPaletteMode(null);
  }, [screenToFlowPosition, store]);

  /** Composite nodes carry their own structure, so each seeds a starter shape. */
  const onPickSpecial = useCallback((special: SpecialNode) => {
    const centre = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });

    const id = nanoid();
    const node: ArchNode =
      special === "umlclass"
        ? {
            id,
            type: "umlclass",
            position: { x: centre.x - 95, y: centre.y - 60 },
            data: {
              kind: "umlclass",
              label: "ClassName",
              attributes: [
                { id: nanoid(), name: "id", type: "string", visibility: "private" },
              ],
              methods: [
                { id: nanoid(), name: "save", type: "void", visibility: "public" },
              ],
            },
          }
        : {
            id,
            type: "table",
            position: { x: centre.x - 115, y: centre.y - 60 },
            data: {
              kind: "table",
              label: "new_table",
              columns: [
                { id: nanoid(), name: "id", type: "uuid", pk: true },
                { id: nanoid(), name: "created_at", type: "timestamptz" },
              ],
            },
          };

    store.getState().addNode(node);
    setPaletteMode(null);
  }, [screenToFlowPosition, store]);

  const onPickTech = useCallback((tech: TechDef) => {
    if (paletteMode === "replace" && selectedNode) {
      const data = selectedNode.data as ServiceData;
      // Retitle only if the label still matches the old technology, so a
      // hand-written name like "Orders write replica" survives a swap.
      const oldTech = getTech(data.tech);
      const patch: Partial<ServiceData> =
        !data.label || data.label === oldTech?.label
          ? { tech: tech.id, label: tech.label }
          : { tech: tech.id };

      store.getState().updateNodeData(selectedNode.id, patch);
    } else {
      addTech(tech);
    }

    setPaletteMode(null);
  }, [addTech, paletteMode, selectedNode, store]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPaletteMode(null);
        return;
      }

      if (e.key !== "z" || !(e.ctrlKey || e.metaKey)) {
        return;
      }

      // Let the browser's own undo win while a field has focus.
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }

      e.preventDefault();
      const { undo, redo } = store.getState();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [store]);

  return (
    <main className="relative h-full w-full touch-none bg-bg pt-14">
      <Topbar
        boardId={boardId}
        source={source}
        diagramType={diagramType}
        onDiagramTypeChange={(t) => store.getState().setDiagramType(t)}
      />
      <Toolbar
        onOpenPalette={() => setPaletteMode((m) => (m ? null : "add"))}
        onAddFrame={addFrame}
        onAddGroup={addGroup}
        onTidyUp={onTidyUp}
        onImport={() => setImportOpen(true)}
        isLayingOut={isLayingOut}
        onDelete={() => store.getState().deleteSelected()}
        undo={() => store.getState().undo()}
        redo={() => store.getState().redo()}
        canUndo={canUndo}
        canRedo={canRedo}
        hasSelection={hasSelection}
        isPaletteOpen={paletteMode !== null}
      />
      <ErMarkers />
      <ZoomControls />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={onImport}
      />
      {paletteMode ? (
        <NodePalette
          onPick={onPickTech}
          onPickShape={onPickShape}
          onPickSpecial={onPickSpecial}
          onClose={() => setPaletteMode(null)}
          techOnly={paletteMode === "replace"}
          diagramType={activeDiagramType}
        />
      ) : null}
      {selectedNode ? (
        <Inspector
          node={selectedNode}
          onChange={(patch) =>
            store.getState().updateNodeData(selectedNode.id, patch)
          }
          onChangeTech={() => setPaletteMode("replace")}
        />
      ) : null}
      {/* Only on the file-backed canvas: a scratch board in localStorage has no
          project to own a component, and offering the button there would fail
          on click rather than explain itself. */}
      {selectedNode && source === "file" ? (
        <ComponentStrip
          diagramId={boardId}
          nodeId={selectedNode.id}
          componentId={selectedNode.data.componentId}
          label={"label" in selectedNode.data ? selectedNode.data.label : selectedNode.id}
          onTracked={(componentId) =>
            store.getState().updateNodeData(selectedNode.id, { componentId })
          }
        />
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes) => store.getState().onNodesChange(changes)}
        onEdgesChange={(changes) => store.getState().onEdgesChange(changes)}
        onConnect={(connection) => store.getState().onConnect(connection)}
        // A drag fires a change per pointer move; collapsing them between
        // start and stop is what makes one drag one undo step.
        onNodeDragStart={() => store.getState().pause()}
        onNodeDragStop={onNodeDragStop}
        onMoveEnd={(_, viewport) => store.getState().setViewport(viewport)}
        defaultViewport={initialViewport}
        // Loose mode lets a single handle per side act as both source and
        // target, so a node needs four handles rather than eight.
        connectionMode={ConnectionMode.Loose}
        onBeforeDelete={onBeforeDelete}
        deleteKeyCode={["Backspace", "Delete"]}
        minZoom={0.1}
        maxZoom={2.5}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="rgb(var(--border-strong))"
        />
        {/*
          No maskColor/nodeColor props: React Flow turns those into
          `--xy-minimap-*-props`, which outrank anything a stylesheet can say.
          Hardcoding them there is what pinned the minimap to light. The colours
          come from tokens in globals.css instead.
        */}
        <MiniMap
          pannable
          zoomable
          className="!bottom-16 !right-3 !rounded-lg !border !border-line !shadow-md"
        />
      </ReactFlow>
    </main>
  );
};

interface ArchCanvasProps {
  boardId: string;
  /** "file" reads and writes the project store over the local API. */
  source?: "local" | "file";
  /** Which project. Defaults to the one the app is running inside. */
  root?: string;
}

export const ArchCanvas = ({
  boardId,
  source = "local",
  root,
}: ArchCanvasProps) => {
  const persistence = useMemo(
    () =>
      source === "file"
        ? filePersistence(boardId, root)
        : localStoragePersistence(boardId),
    [boardId, source, root],
  );

  return (
    <ArchProvider boardId={boardId} persistence={persistence}>
      <NodeTasksProvider enabled={source === "file"} root={root}>
        <EdgeLabelProvider>
          <ReactFlowProvider>
            <Flow boardId={boardId} source={source} />
          </ReactFlowProvider>
        </EdgeLabelProvider>
      </NodeTasksProvider>
    </ArchProvider>
  );
};
