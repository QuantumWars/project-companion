"use client";

import {
  Database,
  Frame,
  Group,
  LayoutGrid,
  Loader2,
  MousePointer2,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Hint } from "@/components/hint";

interface ToolbarProps {
  onOpenPalette: () => void;
  onAddFrame: () => void;
  onAddGroup: () => void;
  onTidyUp: () => void;
  onImport: () => void;
  onDelete: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  isPaletteOpen: boolean;
  isLayingOut: boolean;
}

/** A single rail button. Kept local so the rail can style itself freely. */
const RailButton = ({
  label,
  icon: Icon,
  onClick,
  isActive,
  isDisabled,
  spin,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  isActive?: boolean;
  isDisabled?: boolean;
  spin?: boolean;
}) => (
  <Hint label={label} side="right" sideOffset={12}>
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
        isActive
          ? "bg-brand-subtle text-brand"
          : "text-fg-muted hover:bg-bg-subtle",
        isDisabled && "pointer-events-none opacity-30",
      )}
    >
      <Icon className={cn("h-[18px] w-[18px]", spin && "animate-spin")} />
    </button>
  </Hint>
);

export const Toolbar = ({
  onOpenPalette,
  onAddFrame,
  onAddGroup,
  onTidyUp,
  onImport,
  onDelete,
  undo,
  redo,
  canUndo,
  canRedo,
  hasSelection,
  isPaletteOpen,
  isLayingOut,
}: ToolbarProps) => (
  <>
    {/* Tool rail, pinned left below the header. */}
    <div className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-y-0.5 rounded-xl border border-line bg-panel p-1.5 shadow-md">
      <RailButton
        label="Select"
        icon={MousePointer2}
        onClick={() => {}}
        isActive={!isPaletteOpen}
      />
      <RailButton
        label="Shapes and technologies"
        icon={Plus}
        onClick={onOpenPalette}
        isActive={isPaletteOpen}
      />
      <RailButton label="Add frame" icon={Frame} onClick={onAddFrame} />
      <RailButton label="Add container" icon={Group} onClick={onAddGroup} />
      <RailButton
        label={isLayingOut ? "Tidying up..." : "Tidy up"}
        icon={isLayingOut ? Loader2 : LayoutGrid}
        onClick={onTidyUp}
        isDisabled={isLayingOut}
        spin={isLayingOut}
      />
      <RailButton label="Import schema" icon={Database} onClick={onImport} />
      <span className="my-1 h-px bg-neutral-200" />
      <RailButton
        label="Delete"
        icon={Trash2}
        onClick={onDelete}
        isDisabled={!hasSelection}
      />
    </div>

    {/* History sits bottom-left, away from the tools, as in Miro. */}
    <div className="absolute bottom-3 left-3 z-20 flex items-center gap-x-0.5 rounded-lg border border-line bg-panel p-1 shadow-md">
      <RailButton label="Undo" icon={Undo2} onClick={undo} isDisabled={!canUndo} />
      <RailButton label="Redo" icon={Redo2} onClick={redo} isDisabled={!canRedo} />
    </div>
  </>
);
