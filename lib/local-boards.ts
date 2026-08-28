"use client";

/**
 * Board registry backed by localStorage, replacing the Convex `boards` table.
 *
 * Only board metadata lives here (id + title + kind). The canvas contents for
 * a board are owned by whichever engine that board's kind selects, keyed by
 * the same board id: the local Liveblocks shim for whiteboards, the arch store
 * for architecture diagrams.
 */

import { useCallback, useSyncExternalStore } from "react";

import { clearRoomStorage } from "@/liveblocks.config";
import { clearArchStorage } from "@/lib/arch/storage";

/** Which canvas engine a board opens in. */
export type BoardKind = "whiteboard" | "arch";

export type LocalBoard = {
  id: string;
  title: string;
  createdAt: number;
  /** Absent on boards created before architecture diagrams existed. */
  kind?: BoardKind;
};

/**
 * Always read the kind through this: boards already in localStorage have no
 * `kind` field, so a direct `board.kind === "whiteboard"` check is false for
 * every pre-existing board.
 */
export const boardKind = (board: LocalBoard): BoardKind =>
  board.kind ?? "whiteboard";

export const boardHref = (board: LocalBoard): string =>
  boardKind(board) === "arch" ? `/arch/${board.id}` : `/board/${board.id}`;

const KEY = "miro-clone:boards";
const EMPTY: readonly LocalBoard[] = Object.freeze([]);

const isBrowser = typeof window !== "undefined";

let cache: readonly LocalBoard[] | null = null;
const listeners = new Set<() => void>();

const read = (): readonly LocalBoard[] => {
  if (!isBrowser) {
    return EMPTY;
  }

  if (cache !== null) {
    return cache;
  }

  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as LocalBoard[]) : [];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }

  return cache;
};

const write = (boards: readonly LocalBoard[]) => {
  cache = boards;

  if (isBrowser) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(boards));
    } catch {
      // ignore quota / private-mode failures
    }
  }

  listeners.forEach((listener) => listener());
};

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};

const getServerSnapshot = () => EMPTY;

export const createBoard = (
  title = "Untitled",
  kind: BoardKind = "whiteboard",
): LocalBoard => {
  const board: LocalBoard = {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    kind,
  };

  write([board, ...read()]);
  return board;
};

export const renameBoard = (id: string, title: string) => {
  write(read().map((board) => (board.id === id ? { ...board, title } : board)));
};

export const deleteBoard = (id: string) => {
  write(read().filter((board) => board.id !== id));

  // A board id only ever belongs to one engine, but clearing both is cheap and
  // means a kind that was mis-set can never leave orphaned canvas data behind.
  clearRoomStorage(id);
  clearArchStorage(id);
};

/**
 * Boards opened by direct URL are registered on the fly, so a shared or
 * hand-typed `/board/<id>` link still resolves to a real, renameable board.
 * The kind comes from which route did the registering.
 */
export const ensureBoard = (
  id: string,
  kind: BoardKind = "whiteboard",
): LocalBoard => {
  const existing = read().find((board) => board.id === id);
  if (existing) {
    return existing;
  }

  const board: LocalBoard = {
    id,
    title: "Untitled",
    createdAt: Date.now(),
    kind,
  };
  write([board, ...read()]);
  return board;
};

export const useBoards = (): readonly LocalBoard[] =>
  useSyncExternalStore(subscribe, read, getServerSnapshot);

export const useBoard = (id: string): LocalBoard | undefined => {
  const getSnapshot = useCallback(
    () => read().find((board) => board.id === id),
    [id],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
};
