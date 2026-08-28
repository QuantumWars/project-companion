"use client";

/**
 * Makes the task board visible on the architecture canvas.
 *
 * A node that has work in flight should say so -- that is the whole point of
 * linking tasks to `nodeIds`. Without this the two surfaces are just two lists
 * that happen to share a repository.
 *
 * Only file-backed boards have tasks; a localStorage board gets an empty map
 * and renders no badges.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { Task, TaskStatus } from "./types";

type NodeTasks = Record<string, Task[]>;

const NodeTasksContext = createContext<NodeTasks>({});

export const NodeTasksProvider = ({
  enabled,
  root,
  children,
}: {
  enabled: boolean;
  root?: string;
  children: ReactNode;
}) => {
  const [byNode, setByNode] = useState<NodeTasks>({});

  useEffect(() => {
    if (!enabled) return;

    const load = () =>
      fetch(`/api/project/tasks${root ? `?root=${encodeURIComponent(root)}` : ""}`, {
        cache: "no-store",
      })
        .then((r) => r.json())
        .then((body: { tasks?: Task[] }) => {
          const map: NodeTasks = {};
          for (const task of body.tasks ?? []) {
            for (const id of task.nodeIds ?? []) {
              (map[id] ??= []).push(task);
            }
          }
          setByNode(map);
        })
        .catch(() => {});

    void load();

    // An agent moves cards while you are in the terminal; refresh on return.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, root]);

  return (
    <NodeTasksContext.Provider value={byNode}>
      {children}
    </NodeTasksContext.Provider>
  );
};

export const useNodeTasks = (nodeId: string): Task[] =>
  useContext(NodeTasksContext)[nodeId] ?? [];

/** Only work that is actually moving is worth a badge. */
export const ACTIVE_STATUSES: TaskStatus[] = ["todo", "in_progress", "review"];

export const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: "bg-neutral-300",
  todo: "bg-sky-400",
  in_progress: "bg-amber-400",
  review: "bg-violet-400",
  done: "bg-emerald-400",
};
