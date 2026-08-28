"use client";

import { ReactNode } from "react";
import { ClientSideSuspense } from "@liveblocks/react";
import { LiveMap, LiveList, LiveObject } from "@liveblocks/client";

import { useMemo } from "react";

import { Layer } from "@/types/canvas";
import { RoomProvider } from "@/liveblocks.config";
import {
  fileBoardPersistence,
  localBoardPersistence,
} from "@/lib/board/persistence";

interface RoomProps { 
  children: ReactNode
  roomId: string;
  /** "file" stores the board in the project, where an agent can see it. */
  source?: "local" | "file";
  /** Which project. Defaults to the one the app is running inside. */
  root?: string;
  fallback: NonNullable<ReactNode> | null;
};

export const Room = ({ 
  children,
  roomId,
  source = "local",
  root,
  fallback,
}: RoomProps) => {
  const persistence = useMemo(
    () =>
      source === "file"
        ? fileBoardPersistence(roomId, root)
        : localBoardPersistence(roomId),
    [roomId, source, root],
  );

  return (
    <RoomProvider 
      id={roomId} 
      persistence={persistence}
      initialPresence={{
        cursor: null,
        selection: [],
        pencilDraft: null,
        penColor: null,
      }}
      initialStorage={{
        layers: new LiveMap<string, LiveObject<Layer>>(),
        layerIds: new LiveList(),
      }}
    >
      <ClientSideSuspense fallback={fallback}>
        {() => children}
      </ClientSideSuspense>
    </RoomProvider>
  );
};
