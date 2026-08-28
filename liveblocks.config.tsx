"use client";

/**
 * Offline, single-player replacement for the Liveblocks room bundle.
 *
 * The canvas keeps talking to the exact same hook API it used before
 * (`useStorage`, `useMutation`, `useHistory`, ...), but nothing leaves the
 * browser: storage lives in real `LiveMap`/`LiveList`/`LiveObject` instances
 * that are never attached to a room, and it is persisted to localStorage.
 *
 * The Live* structures are used unattached on purpose -- they still apply
 * mutations and, crucially, `toImmutable()` memoises per node and invalidates
 * only up the path that changed. That gives per-layer render granularity for
 * free. What they no longer do is notify anyone, so reactivity here comes from
 * version counters bumped after each mutation.
 *
 * Multiplayer is gone: there is exactly one user and `useOthers()` is always
 * empty, so cursors and remote selections never render.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { LiveList, LiveMap, LiveObject } from "@liveblocks/client";

import type { Color, Layer } from "@/types/canvas";
import {
  BOARD_STORAGE_PREFIX,
  localBoardPersistence,
  type BoardDocument,
  type BoardPersistence,
} from "@/lib/board/persistence";

export type Presence = {
  cursor: { x: number; y: number } | null;
  selection: string[];
  pencilDraft: [x: number, y: number, pressure: number][] | null;
  penColor: Color | null;
};

export type Storage = {
  layers: LiveMap<string, LiveObject<Layer>>;
  layerIds: LiveList<string>;
};

export type UserMeta = {
  id?: string;
  info?: {
    name?: string;
    picture?: string;
  };
};

/** The read-only view handed to `useStorage` selectors. */
export type ImmutableRoot = {
  layers: ReadonlyMap<string, Layer>;
  layerIds: readonly string[];
};

export type Self = {
  connectionId: number;
  id: string;
  info: UserMeta["info"];
  presence: Presence;
};

export type StorageRoot = {
  get<K extends keyof Storage>(key: K): Storage[K];
};

export type MutationContext = {
  storage: StorageRoot;
  self: Self;
  setMyPresence: (
    patch: Partial<Presence>,
    options?: { addToHistory?: boolean },
  ) => void;
};

const SELF_CONNECTION_ID = 1;
const SELF_INFO: UserMeta["info"] = { name: "Guest" };
const MAX_HISTORY = 100;

type Snapshot = {
  root: ImmutableRoot;
  selection: string[];
};

type PersistedRoom = {
  layerIds: string[];
  layers: [string, Layer][];
};

const isBrowser = typeof window !== "undefined";

class LocalRoom {
  readonly id: string;

  private layers: LiveMap<string, LiveObject<Layer>>;
  private layerIds: LiveList<string>;
  private presence: Presence;

  private storageVersion = 0;
  private presenceVersion = 0;
  private historyVersion = 0;

  private storageListeners = new Set<() => void>();
  private presenceListeners = new Set<() => void>();
  private historyListeners = new Set<() => void>();

  private rootCache: ImmutableRoot | null = null;
  private selfCache: Self | null = null;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private pauseDepth = 0;
  private pausedSnapshot: Snapshot | null = null;
  private addToHistoryFlag = false;

  private mutationDepth = 0;
  private batchRootBefore: ImmutableRoot | null = null;
  private batchSelectionBefore: string[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly storageRoot: StorageRoot = {
    get: (<K extends keyof Storage>(key: K) =>
      (key === "layers" ? this.layers : this.layerIds) as Storage[K]),
  };

  private persistence: BoardPersistence;

  constructor(
    id: string,
    initialPresence: Presence,
    initialStorage: Storage,
    persistence: BoardPersistence,
  ) {
    this.id = id;
    this.presence = initialPresence;
    this.persistence = persistence;

    // The room starts from `initialStorage` and hydrates when `load` resolves,
    // so an async backing (the project store, over HTTP) does not block the
    // first paint.
    this.layers = initialStorage.layers;
    this.layerIds = initialStorage.layerIds;

    if (isBrowser) {
      window.addEventListener("pagehide", () => this.persistNow());

      void persistence.load().then((doc: BoardDocument | null) => {
        if (!doc) return;

        this.layers = new LiveMap(
          doc.layers.map(([key, layer]): [string, LiveObject<Layer>] => [
            key,
            new LiveObject(layer),
          ]),
        );
        this.layerIds = new LiveList(doc.layerIds);
        this.rootCache = null;
        // Hydration is not an edit: it must not land on the undo stack.
        this.bumpStorage();
      });

      // Someone else changed the board -- an agent, or another window.
      persistence.watch?.((doc) => {
        this.layers = new LiveMap(
          doc.layers.map(([key, layer]): [string, LiveObject<Layer>] => [
            key,
            new LiveObject(layer),
          ]),
        );
        this.layerIds = new LiveList(doc.layerIds);
        this.rootCache = null;
        this.bumpStorage();
      });
    }
  }

  /* ----------------------------- subscriptions ---------------------------- */

  subscribeStorage = (onChange: () => void) => {
    this.storageListeners.add(onChange);
    return () => void this.storageListeners.delete(onChange);
  };

  subscribePresence = (onChange: () => void) => {
    this.presenceListeners.add(onChange);
    return () => void this.presenceListeners.delete(onChange);
  };

  subscribeHistory = (onChange: () => void) => {
    this.historyListeners.add(onChange);
    return () => void this.historyListeners.delete(onChange);
  };

  getStorageVersion = () => this.storageVersion;
  getPresenceVersion = () => this.presenceVersion;
  getHistoryVersion = () => this.historyVersion;
  getServerVersion = () => 0;

  private bumpStorage() {
    this.storageVersion++;
    this.storageListeners.forEach((listener) => listener());
  }

  private bumpPresence() {
    this.presenceVersion++;
    this.selfCache = null;
    this.presenceListeners.forEach((listener) => listener());
  }

  private bumpHistory() {
    this.historyVersion++;
    this.historyListeners.forEach((listener) => listener());
  }

  /* -------------------------------- reads --------------------------------- */

  getRoot = (): ImmutableRoot => {
    // `toImmutable()` is memoised per node, so these identities only change
    // where something actually changed.
    const layers = this.layers.toImmutable() as ReadonlyMap<string, Layer>;
    const layerIds = this.layerIds.toImmutable() as readonly string[];

    if (
      this.rootCache === null ||
      this.rootCache.layers !== layers ||
      this.rootCache.layerIds !== layerIds
    ) {
      this.rootCache = { layers, layerIds };
    }

    return this.rootCache;
  };

  getSelf = (): Self => {
    if (this.selfCache === null) {
      this.selfCache = {
        connectionId: SELF_CONNECTION_ID,
        id: "local-user",
        info: SELF_INFO,
        presence: this.presence,
      };
    }

    return this.selfCache;
  };

  /* ------------------------------- mutations ------------------------------ */

  private setMyPresence = (
    patch: Partial<Presence>,
    options?: { addToHistory?: boolean },
  ) => {
    this.presence = { ...this.presence, ...patch };
    if (options?.addToHistory) {
      this.addToHistoryFlag = true;
    }
    this.bumpPresence();
  };

  runMutation = <R,>(fn: (context: MutationContext) => R): R => {
    // Mutations nest: a pointer handler is itself a mutation that calls other
    // mutations. Only the outermost call commits, so a nested one joins its
    // parent's batch rather than recording a second, identical history entry
    // for the same edit. This mirrors how Liveblocks batches mutations.
    const isOutermost = this.mutationDepth === 0;

    if (isOutermost) {
      this.batchRootBefore = this.getRoot();
      this.batchSelectionBefore = this.presence.selection;
      this.addToHistoryFlag = false;
    }

    this.mutationDepth++;

    try {
      return fn({
        storage: this.storageRoot,
        self: this.getSelf(),
        setMyPresence: this.setMyPresence,
      });
    } finally {
      this.mutationDepth--;

      if (this.mutationDepth === 0) {
        this.commit();
      }
    }
  };

  private commit() {
    const rootBefore = this.batchRootBefore;
    this.batchRootBefore = null;

    if (rootBefore === null) {
      return;
    }

    const storageChanged = rootBefore !== this.getRoot();

    if (storageChanged) {
      this.bumpStorage();
      this.schedulePersist();
    }

    if (storageChanged || this.addToHistoryFlag) {
      this.record({ root: rootBefore, selection: this.batchSelectionBefore });
    }

    this.addToHistoryFlag = false;
  }

  /* -------------------------------- history ------------------------------- */

  private record(entry: Snapshot) {
    // While paused every change collapses into the single entry captured at
    // `pause()`, which is what makes a drag one undo step instead of hundreds.
    if (this.pauseDepth > 0) {
      return;
    }

    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.bumpHistory();
  }

  private snapshot = (): Snapshot => ({
    root: this.getRoot(),
    selection: this.presence.selection,
  });

  private restore(snapshot: Snapshot) {
    this.layers = new LiveMap(
      Array.from(snapshot.root.layers, ([key, layer]) => [
        key,
        new LiveObject({ ...layer }),
      ] as [string, LiveObject<Layer>]),
    );
    this.layerIds = new LiveList([...snapshot.root.layerIds]);
    this.presence = { ...this.presence, selection: snapshot.selection };

    this.rootCache = null;
    this.bumpStorage();
    this.bumpPresence();
    this.persistNow();
  }

  pause = () => {
    if (this.pauseDepth === 0) {
      this.pausedSnapshot = this.snapshot();
    }
    this.pauseDepth++;
  };

  resume = () => {
    // `resume()` is called on every pointer-up, including ones that never
    // paused, so an unmatched call has to be a no-op rather than go negative.
    if (this.pauseDepth === 0) {
      return;
    }

    this.pauseDepth--;
    if (this.pauseDepth > 0) {
      return;
    }

    const paused = this.pausedSnapshot;
    this.pausedSnapshot = null;

    if (paused && paused.root !== this.getRoot()) {
      this.undoStack.push(paused);
      if (this.undoStack.length > MAX_HISTORY) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      this.bumpHistory();
    }
  };

  undo = () => {
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }

    this.redoStack.push(this.snapshot());
    this.restore(entry);
    this.bumpHistory();
  };

  redo = () => {
    const entry = this.redoStack.pop();
    if (!entry) {
      return;
    }

    this.undoStack.push(this.snapshot());
    this.restore(entry);
    this.bumpHistory();
  };

  clear = () => {
    this.undoStack = [];
    this.redoStack = [];
    this.bumpHistory();
  };

  canUndo = () => this.undoStack.length > 0;
  canRedo = () => this.redoStack.length > 0;

  /* ------------------------------ persistence ----------------------------- */

  /** Dragging fires a mutation per pointer move; don't serialise on each one. */
  private schedulePersist() {
    if (!isBrowser || this.persistTimer !== null) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist(this.getRoot());
    }, 150);
  }

  private persistNow() {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    this.persist(this.getRoot());
  }

  private persist(root: ImmutableRoot) {
    this.persistence.save({
      layerIds: Array.from(root.layerIds),
      layers: Array.from(root.layers),
    });
  }
}

/** Wipes a board's persisted canvas. Used when a board is deleted. */
export const clearRoomStorage = (roomId: string) => {
  rooms.delete(`local:${roomId}`);
  rooms.delete(`file:${roomId}`);

  if (!isBrowser) {
    return;
  }

  try {
    window.localStorage.removeItem(`${BOARD_STORAGE_PREFIX}${roomId}`);
  } catch {
    // ignore
  }
};

const rooms = new Map<string, LocalRoom>();

const getRoom = (
  id: string,
  initialPresence: Presence,
  initialStorage: Storage,
  persistence: BoardPersistence,
): LocalRoom => {
  // Rooms are only cached in the browser; on the server every render gets a
  // throwaway empty room so requests can't leak state into each other.
  if (!isBrowser) {
    return new LocalRoom(id, initialPresence, initialStorage, persistence);
  }

  // Keyed by backing as well as id: a localStorage board and a file-backed one
  // with the same id are different documents.
  const key = `${persistence.kind}:${id}`;
  const existing = rooms.get(key);
  if (existing) {
    return existing;
  }

  const room = new LocalRoom(id, initialPresence, initialStorage, persistence);
  rooms.set(key, room);
  return room;
};

/* ---------------------------------- hooks --------------------------------- */

const RoomContext = createContext<LocalRoom | null>(null);

interface RoomProviderProps {
  id: string;
  initialPresence: Presence;
  initialStorage: Storage;
  /** Defaults to localStorage; project boards pass the file backing. */
  persistence?: BoardPersistence;
  children: ReactNode;
}

export const RoomProvider = ({
  id,
  initialPresence,
  initialStorage,
  persistence,
  children,
}: RoomProviderProps) => {
  const room = useMemo(
    () => getRoom(id, initialPresence, initialStorage, persistence ?? localBoardPersistence(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, persistence],
  );

  return (
    <RoomContext.Provider value={room}>{children}</RoomContext.Provider>
  );
};

export const useRoom = (): LocalRoom => {
  const room = useContext(RoomContext);

  if (!room) {
    throw new Error("useRoom() must be used inside a <RoomProvider />");
  }

  return room;
};

/**
 * Re-runs `selector` whenever `version` changes and keeps the previous result
 * when `isEqual` says nothing meaningful moved, so consumers passing `shallow`
 * keep a stable identity.
 */
const useSelectorCache = <T,>(
  next: T,
  isEqual: (a: T, b: T) => boolean,
): T => {
  const cache = useRef<{ value: T } | null>(null);

  if (cache.current === null || !isEqual(cache.current.value, next)) {
    cache.current = { value: next };
  }

  return cache.current.value;
};

export function useStorage<T>(
  selector: (root: ImmutableRoot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const room = useRoom();

  useSyncExternalStore(
    room.subscribeStorage,
    room.getStorageVersion,
    room.getServerVersion,
  );

  return useSelectorCache(selector(room.getRoot()), isEqual);
}

export function useSelf(): Self;
export function useSelf<T>(
  selector: (me: Self) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useSelf<T>(
  selector?: (me: Self) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
) {
  const room = useRoom();

  useSyncExternalStore(
    room.subscribePresence,
    room.getPresenceVersion,
    room.getServerVersion,
  );

  const me = room.getSelf();
  return useSelectorCache(selector ? selector(me) : (me as unknown as T), isEqual);
}

export function useMyPresence(): [
  Presence,
  MutationContext["setMyPresence"],
] {
  const room = useRoom();

  useSyncExternalStore(
    room.subscribePresence,
    room.getPresenceVersion,
    room.getServerVersion,
  );

  return [room.getSelf().presence, useUpdateMyPresence()];
}

export function useUpdateMyPresence(): MutationContext["setMyPresence"] {
  const room = useRoom();

  return useCallback(
    (patch, options) => room.runMutation(({ setMyPresence }) =>
      setMyPresence(patch, options),
    ),
    [room],
  );
}

type OmitFirstArg<F> = F extends (first: any, ...rest: infer A) => infer R
  ? (...args: A) => R
  : never;

export function useMutation<
  F extends (context: MutationContext, ...args: any[]) => any,
>(callback: F, deps: readonly unknown[]): OmitFirstArg<F> {
  const room = useRoom();

  return useCallback(
    ((...args: any[]) =>
      room.runMutation((context) =>
        callback(context, ...args),
      )) as OmitFirstArg<F>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, ...deps],
  );
}

export function useHistory() {
  const room = useRoom();

  return useMemo(
    () => ({
      undo: room.undo,
      redo: room.redo,
      pause: room.pause,
      resume: room.resume,
      clear: room.clear,
    }),
    [room],
  );
}

export function useCanUndo(): boolean {
  const room = useRoom();

  useSyncExternalStore(
    room.subscribeHistory,
    room.getHistoryVersion,
    room.getServerVersion,
  );

  return room.canUndo();
}

export function useCanRedo(): boolean {
  const room = useRoom();

  useSyncExternalStore(
    room.subscribeHistory,
    room.getHistoryVersion,
    room.getServerVersion,
  );

  return room.canRedo();
}

/* ------------------------- multiplayer: nobody home ------------------------ */

export type User = {
  connectionId: number;
  id?: string;
  info?: UserMeta["info"];
  presence: Presence;
};

const NO_OTHERS: readonly never[] = Object.freeze([]);

export function useOthers(): readonly User[];
export function useOthers<T>(
  selector: (others: readonly User[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useOthers<T>(selector?: (others: readonly User[]) => T) {
  return selector
    ? selector(NO_OTHERS as unknown as readonly User[])
    : (NO_OTHERS as unknown as readonly User[]);
}

export function useOthersMapped<T>(
  _selector: (other: User) => T,
  _isEqual?: (a: T, b: T) => boolean,
): readonly (readonly [connectionId: number, data: T])[] {
  return NO_OTHERS as unknown as readonly (readonly [number, T])[];
}

export function useOthersConnectionIds(): readonly number[] {
  return NO_OTHERS as unknown as readonly number[];
}

export function useOther<T>(
  _connectionId: number,
  _selector: (user: User) => T,
): T {
  // Unreachable in practice: `useOthersConnectionIds()` is always empty, so
  // nothing ever renders a remote cursor to ask about.
  return undefined as unknown as T;
}
