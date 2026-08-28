"use client";

import Link from "next/link";
import Image from "next/image";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Poppins } from "next/font/google";

import { cn } from "@/lib/utils";
import { Hint } from "@/components/hint";
import { Actions } from "@/components/actions";
import { StoreBadge } from "@/components/store-badge";
import { Button } from "@/components/ui/button";
import { ensureBoard, useBoard } from "@/lib/local-boards";
import { useRenameModal } from "@/store/use-rename-modal";

interface InfoProps {
  boardId: string;
  source?: "local" | "file";
};

const font = Poppins({
  subsets: ["latin"],
  weight: ["600"],
});

const TabSeparator = () => {
  return (
    <div className="text-neutral-300 px-1.5">
      |
    </div>
  );
};

export const Info = ({
  boardId,
  source = "local",
}: InfoProps) => {
  const { onOpen } = useRenameModal();
  const data = useBoard(boardId);
  const [fileTitle, setFileTitle] = useState<string | null>(null);

  useEffect(() => {
    if (source === "file") {
      // A project board is not in the localStorage registry; its title lives
      // in the project store.
      fetch(`/api/project/boards/${encodeURIComponent(boardId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => b && setFileTitle(b.title))
        .catch(() => {});
      return;
    }

    // A board reached by direct URL may not be in the registry yet.
    ensureBoard(boardId);
  }, [boardId, source]);

  if (source === "file") {
    return (
      <div className="absolute top-2 left-2 z-10 bg-white rounded-md px-1.5 h-12 flex items-center shadow-md">
        <Hint label="Go to boards" side="bottom" sideOffset={10}>
          <Button asChild variant="board" className="px-2">
            <Link href="/">
              <Image src="/logo.svg" alt="Board logo" height={40} width={40} />
              <span className={cn("font-semibold text-xl ml-2 text-black", font.className)}>
                Board
              </span>
            </Link>
          </Button>
        </Hint>
        <TabSeparator />
        <span className="px-2 text-base">{fileTitle ?? boardId}</span>
        <span className="ml-2"><StoreBadge /></span>
      </div>
    );
  }

  if (!data) return <InfoSkeleton />;

  return (
    <div className="absolute top-2 left-2 bg-white rounded-md px-1.5 h-12 flex items-center shadow-md">
      <Hint label="Go to boards" side="bottom" sideOffset={10}>
        <Button asChild variant="board" className="px-2">
          <Link href="/">
            <Image
              src="/logo.svg"
              alt="Board logo"
              height={40}
              width={40}
            />
            <span className={cn(
              "font-semibold text-xl ml-2 text-black",
              font.className,
            )}>
              Board
            </span>
          </Link>
        </Button>
      </Hint>
      <TabSeparator />
      <Hint label="Edit title" side="bottom" sideOffset={10}>
        <Button
          variant="board"
          className="text-base font-normal px-2"
          onClick={() => onOpen(data.id, data.title)}
        >
          {data.title}
        </Button>
      </Hint>
      <TabSeparator />
      <Actions
        id={data.id}
        title={data.title}
        side="bottom"
        sideOffset={10}
      >
        <div>
          <Hint label="Main menu" side="bottom" sideOffset={10}>
            <Button size="icon" variant="board">
              <Menu />
            </Button>
          </Hint>
        </div>
      </Actions>
    </div>
  );
};

export const InfoSkeleton = () => {
  return (
    <div 
      className="absolute top-2 left-2 bg-white rounded-md px-1.5 h-12 flex items-center shadow-md w-[300px]"
    />
  );
};
