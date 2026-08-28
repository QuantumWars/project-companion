"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Database } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { parseSqlDdl } from "@/lib/arch/import/sql-ddl";
import { parsePrismaSchema } from "@/lib/arch/import/prisma";
import type { ImportResult } from "@/lib/arch/import/types";

type Format = "auto" | "sql" | "prisma";

/** Prisma has `model X {`; SQL has `CREATE TABLE`. Either is enough to tell. */
const detect = (text: string): "sql" | "prisma" => {
  if (/^\s*model\s+\w+\s*\{/m.test(text)) return "prisma";
  if (/create\s+table/i.test(text)) return "sql";
  return /@id\b|@relation\s*\(/.test(text) ? "prisma" : "sql";
};

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (result: ImportResult) => void;
}

export const ImportDialog = ({
  open,
  onOpenChange,
  onImport,
}: ImportDialogProps) => {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<Format>("auto");

  const resolved = format === "auto" ? detect(text) : format;

  // Parsing is cheap and pure, so the preview can just run it on every edit.
  const preview = useMemo<ImportResult | null>(() => {
    if (!text.trim()) return null;
    try {
      return resolved === "prisma" ? parsePrismaSchema(text) : parseSqlDdl(text);
    } catch {
      return null;
    }
  }, [text, resolved]);

  const canImport = (preview?.nodes.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-x-2">
            <Database className="h-4 w-4" />
            Import a schema
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-x-1">
          {(["auto", "sql", "prisma"] as Format[]).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={cn(
                "rounded px-2.5 py-1 text-xs capitalize transition-colors",
                format === f
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-600 hover:bg-neutral-100",
              )}
            >
              {f === "auto" ? "Auto-detect" : f === "sql" ? "SQL DDL" : "Prisma"}
            </button>
          ))}
          {format === "auto" && text.trim() ? (
            <span className="ml-1 text-xs text-neutral-400">
              detected: {resolved === "prisma" ? "Prisma" : "SQL"}
            </span>
          ) : null}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={"CREATE TABLE users (\n  id uuid PRIMARY KEY,\n  email varchar(255) NOT NULL UNIQUE\n);\n\n-- or paste a Prisma schema"}
          className="h-64 w-full resize-none rounded-md border border-neutral-200 p-3 font-mono text-xs leading-relaxed outline-none focus:border-neutral-400"
        />

        <div className="flex items-end justify-between gap-x-4">
          <div className="min-w-0 flex-1 text-xs">
            {preview ? (
              <>
                <p className="text-neutral-600">
                  {preview.nodes.length} table
                  {preview.nodes.length === 1 ? "" : "s"} &middot;{" "}
                  {preview.edges.length} relation
                  {preview.edges.length === 1 ? "" : "s"}
                </p>
                {preview.warnings.length > 0 ? (
                  <div className="mt-1 space-y-0.5">
                    {preview.warnings.slice(0, 3).map((w) => (
                      <p
                        key={w}
                        className="flex items-start gap-x-1 text-[11px] text-amber-600"
                      >
                        <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
                        <span className="truncate">{w}</span>
                      </p>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-neutral-400">
                Paste SQL DDL or a Prisma schema. Nothing leaves your browser.
              </p>
            )}
          </div>

          <Button
            disabled={!canImport}
            onClick={() => {
              if (preview) onImport(preview);
              setText("");
              onOpenChange(false);
            }}
          >
            Import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
