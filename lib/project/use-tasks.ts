"use client";

/**
 * Client-side task board state.
 *
 * Every mutation is applied optimistically and then reconciled with the
 * server's answer. The board is also edited by agents through MCP and the CLI,
 * so it follows the change stream and refetches on window focus -- a card an
 * agent moved while you were in
 * the terminal should be in the right column when you look back.
 */

import { useCallback, useEffect, useState } from "react";

import { useProjectStream } from "./use-stream";

import type { Task, TaskStatus } from "./types";

export const useTasks = (root?: string) => {
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/project/tasks${query}`, { cache: "no-store" });
      const body = (await res.json()) as { configured: boolean; tasks: Task[] };
      setConfigured(body.configured);
      setTasks(body.tasks ?? []);
    } catch {
      setConfigured(false);
    } finally {
      setLoading(false);
    }
  }, [query]);

  // The board refreshed on focus alone, so a card an agent moved while you were
  // looking at the board stayed where it was until you left and came back.
  useProjectStream(() => void refresh(), { only: ["project"] });

  useEffect(() => {
    void refresh();

    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const move = useCallback(
    async (id: string, status: TaskStatus, index?: number) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status } : t)),
      );

      await fetch(`/api/project/tasks/${id}${query}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(index === undefined ? { status } : { status, index }),
      }).catch(() => {});

      // The server assigns the order within the column, so read it back.
      void refresh();
    },
    [query, refresh],
  );

  const create = useCallback(
    async (input: {
      title: string;
      status: TaskStatus;
      nodeIds?: string[];
      featureId?: string;
      phaseId?: string;
    }) => {
      await fetch(`/api/project/tasks${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }).catch(() => {});
      void refresh();
    },
    [query, refresh],
  );

  /** Edits a task in place -- the board had no way to change one after creation. */
  const update = useCallback(
    async (id: string, patch: Partial<Task>) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      await fetch(`/api/project/tasks/${id}${query}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
      void refresh();
    },
    [query, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      await fetch(`/api/project/tasks/${id}${query}`, { method: "DELETE" }).catch(() => {});
      void refresh();
    },
    [query, refresh],
  );

  return { tasks, loading, configured, refresh, move, create, update, remove };
};
