"use client";

import { useRouter } from "next/navigation";
import { Network, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Kbd } from "@/components/ui/primitives";
import { DIAGRAM_TYPE_IDS, DIAGRAM_TYPE_LABELS, type DiagramType } from "@/types/arch";
import { cn } from "@/lib/utils";

/**
 * Creating a diagram, from the surface a person is already looking at.
 *
 * This existed only in the CLI and the MCP tools, which meant the most obvious
 * action in the product was unreachable from the product.
 *
 * The type is chosen at creation rather than afterwards because it decides the
 * layout algorithm and the palette's lead family -- picking it later means
 * working against the wrong defaults until you notice.
 */
export const NewDiagram = ({
  root,
  onCreated,
  align = "left",
}: {
  root: string | null;
  onCreated?: () => void;
  align?: "left" | "right";
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DiagramType | "whiteboard">("architecture");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const query = root ? `?root=${encodeURIComponent(root)}` : "";

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Close on an outside click or Escape, the way any popover should.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const submit = async () => {
    const name = title.trim();
    if (!name || busy) return;

    setBusy(true);
    setError(null);
    try {
      const whiteboard = type === "whiteboard";
      const response = await fetch(
        `/api/project/${whiteboard ? "boards" : "diagrams"}${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(whiteboard ? { title: name } : { title: name, type }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not create it.");
        return;
      }

      setOpen(false);
      setTitle("");
      onCreated?.();
      router.push(
        `/project/${whiteboard ? "board" : "diagram"}/${data.id}${query}`,
      );
    } catch {
      setError("Could not reach the project store.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="New diagram"
        aria-label="New diagram"
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded transition-colors",
          open ? "bg-bg-subtle text-fg" : "text-fg-subtle hover:bg-bg-subtle hover:text-fg",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute top-7 z-50 w-64 rounded-xl bg-panel-raised p-3 shadow-lg ring-1 ring-line animate-slide-up",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="Diagram name…"
            className="mb-2 h-8 w-full rounded-md bg-bg-subtle px-2.5 text-sm text-fg outline-none ring-1 ring-inset ring-transparent transition-shadow placeholder:text-fg-subtle focus:bg-panel focus:ring-brand"
          />

          <select
            value={type}
            onChange={(e) => setType(e.target.value as DiagramType | "whiteboard")}
            className="mb-2.5 h-8 w-full rounded-md bg-bg-subtle px-2 text-xs text-fg outline-none ring-1 ring-inset ring-transparent transition-shadow focus:bg-panel focus:ring-brand"
          >
            {DIAGRAM_TYPE_IDS.map((id) => (
              <option key={id} value={id}>
                {DIAGRAM_TYPE_LABELS[id]}
              </option>
            ))}
            <option value="whiteboard">Whiteboard (freehand)</option>
          </select>

          {error ? <p className="mb-2 text-xs text-status-danger">{error}</p> : null}

          <div className="flex items-center gap-x-2">
            <button
              onClick={() => void submit()}
              disabled={!title.trim() || busy}
              className="flex h-7 flex-1 items-center justify-center gap-x-1.5 rounded-md bg-brand text-xs font-medium text-brand-fg transition-colors hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-40"
            >
              {type === "whiteboard" ? (
                <Pencil className="h-3 w-3" />
              ) : (
                <Network className="h-3 w-3" />
              )}
              {busy ? "Creating…" : "Create"}
            </button>
            <Kbd>⏎</Kbd>
          </div>
        </div>
      ) : null}
    </div>
  );
};
