import type { ArchEdge, ArchNode } from "@/types/arch";

/**
 * What every importer returns. Nodes come back **unpositioned** -- ELK assigns
 * coordinates afterwards, so a parser never has to guess at layout.
 */
export type ImportResult = {
  nodes: ArchNode[];
  edges: ArchEdge[];
  /** Non-fatal problems worth showing the user (unresolved FK targets, etc). */
  warnings: string[];
};

export const emptyImport = (): ImportResult => ({
  nodes: [],
  edges: [],
  warnings: [],
});
