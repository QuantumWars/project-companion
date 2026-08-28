"use client";

import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";

import type { ArchPersistence } from "./persistence";
import {
  ArchStoreContext,
  getArchStore,
  useArchStoreApi,
  type ArchState,
} from "./store";

interface ArchProviderProps {
  boardId: string;
  /** Defaults to localStorage; the project routes pass the file backing. */
  persistence?: ArchPersistence;
  children: ReactNode;
}

export const ArchProvider = ({
  boardId,
  persistence,
  children,
}: ArchProviderProps) => {
  const store = useMemo(
    () => getArchStore(boardId, persistence),
    [boardId, persistence],
  );

  return (
    <ArchStoreContext.Provider value={store}>
      {children}
    </ArchStoreContext.Provider>
  );
};

/** Subscribes to a slice of the current board's graph. */
export const useArchStore = <T,>(selector: (state: ArchState) => T): T =>
  useStore(useArchStoreApi(), selector);
