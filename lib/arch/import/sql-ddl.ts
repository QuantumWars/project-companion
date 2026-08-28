/**
 * SQL DDL -> ER diagram.
 *
 * Deliberately dialect-tolerant rather than a full SQL grammar: it reads
 * `CREATE TABLE` bodies and foreign keys well enough for Postgres and MySQL
 * dumps, and ignores everything else (indexes, triggers, grants) instead of
 * failing on it. Parsing beats asking a model to transcribe a schema -- it is
 * deterministic, offline, and cannot invent a column.
 */

import { emptyImport, type ImportResult } from "./types";
import type { ArchEdge, ArchNode, Cardinality, Column } from "@/types/arch";
import { columnHandleId } from "@/types/arch";

type ParsedTable = {
  id: string;
  schema?: string;
  name: string;
  columns: Column[];
};

type ParsedFk = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn?: string;
  unique: boolean;
};

/** Strips `--`, `#` and block comments without touching string literals. */
const stripComments = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/^\s*#[^\n]*$/gm, " ");

/** `"users"`, `` `users` ``, `[users]` and `public.users` all normalise here. */
const unquote = (raw: string): string =>
  raw.trim().replace(/^[`"\[]/, "").replace(/[`"\]]$/, "");

const splitQualified = (raw: string): { schema?: string; name: string } => {
  const parts = raw.trim().split(".").map(unquote).filter(Boolean);
  return parts.length > 1
    ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] }
    : { name: parts[0] ?? "" };
};

/** Reads a balanced parenthesised block starting at `open`. */
const balanced = (text: string, open: number): { body: string; end: number } | null => {
  if (text[open] !== "(") return null;

  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
  }

  return null;
};

/** Splits on commas that are not inside parentheses or quotes. */
const splitTopLevel = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";

  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;

    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  if (current.trim()) out.push(current);
  return out;
};

const CONSTRAINT_START =
  /^\s*(constraint|primary\s+key|foreign\s+key|unique|check|key|index|exclude)\b/i;

export const parseSqlDdl = (sql: string): ImportResult => {
  const result = emptyImport();
  const text = stripComments(sql);

  const tables = new Map<string, ParsedTable>();
  const fks: ParsedFk[] = [];

  /* ------------------------------ CREATE TABLE ----------------------------- */

  const createRe = /create\s+(?:global\s+|local\s+|temp\w*\s+|unlogged\s+)*table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*/gi;
  let match: RegExpExecArray | null;

  while ((match = createRe.exec(text)) !== null) {
    const open = text.indexOf("(", match.index + match[0].length - 1);
    if (open === -1) continue;

    const block = balanced(text, open);
    if (!block) continue;

    const { schema, name } = splitQualified(match[1]);
    if (!name) continue;

    const table: ParsedTable = { id: name.toLowerCase(), schema, name, columns: [] };
    const pkNames = new Set<string>();

    for (const rawPart of splitTopLevel(block.body)) {
      const part = rawPart.trim();
      if (!part) continue;

      if (CONSTRAINT_START.test(part)) {
        const pk = /primary\s+key\s*\(([^)]*)\)/i.exec(part);
        if (pk) {
          for (const c of pk[1].split(",")) pkNames.add(unquote(c).toLowerCase());
        }

        const fk =
          /foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(part);
        if (fk) {
          fks.push({
            fromTable: table.id,
            fromColumn: unquote(fk[1].split(",")[0]),
            toTable: splitQualified(fk[2]).name.toLowerCase(),
            toColumn: fk[3] ? unquote(fk[3].split(",")[0]) : undefined,
            unique: /unique/i.test(part),
          });
        }
        continue;
      }

      // A column definition: name, then type, then trailing constraints.
      const colMatch = /^([`"\[]?[\w$]+[`"\]]?)\s+(.+)$/s.exec(part);
      if (!colMatch) continue;

      const columnName = unquote(colMatch[1]);
      const rest = colMatch[2].trim();
      const typeMatch = /^([\w\s]*?(?:\([^)]*\))?(?:\s*\[\s*\])?)(?=\s+(?:not\s+null|null|default|primary|references|unique|check|generated|auto_increment|collate|comment|on\s+update|constraint)\b|$)/i.exec(rest);
      const type = (typeMatch?.[1] ?? rest.split(/\s+/)[0] ?? "").trim();

      const isPk = /\bprimary\s+key\b/i.test(rest);
      if (isPk) pkNames.add(columnName.toLowerCase());

      table.columns.push({
        id: `${table.id}.${columnName.toLowerCase()}`,
        name: columnName,
        type: type || "unknown",
        pk: isPk || undefined,
        nullable: /\bnot\s+null\b/i.test(rest) ? false : undefined,
        unique: /\bunique\b/i.test(rest) || undefined,
      });

      const inlineRef = /references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(rest);
      if (inlineRef) {
        fks.push({
          fromTable: table.id,
          fromColumn: columnName,
          toTable: splitQualified(inlineRef[1]).name.toLowerCase(),
          toColumn: inlineRef[2] ? unquote(inlineRef[2].split(",")[0]) : undefined,
          unique: /\bunique\b/i.test(rest),
        });
      }
    }

    for (const column of table.columns) {
      if (pkNames.has(column.name.toLowerCase())) column.pk = true;
    }

    tables.set(table.id, table);
  }

  /* --------------------- ALTER TABLE ... ADD FOREIGN KEY -------------------- */

  const alterRe =
    /alter\s+table\s+(?:only\s+)?([^\s]+)[\s\S]*?foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(;]+)\s*(?:\(([^)]*)\))?/gi;

  while ((match = alterRe.exec(text)) !== null) {
    fks.push({
      fromTable: splitQualified(match[1]).name.toLowerCase(),
      fromColumn: unquote(match[2].split(",")[0]),
      toTable: splitQualified(match[3]).name.toLowerCase(),
      toColumn: match[4] ? unquote(match[4].split(",")[0]) : undefined,
      unique: false,
    });
  }

  if (tables.size === 0) {
    result.warnings.push("No CREATE TABLE statements found.");
    return result;
  }

  /* ------------------------------- to a graph ------------------------------ */

  result.nodes = Array.from(tables.values()).map(
    (table): ArchNode => ({
      id: table.id,
      type: "table",
      position: { x: 0, y: 0 },
      data: {
        kind: "table",
        label: table.name,
        schema: table.schema,
        columns: table.columns,
      },
    }),
  );

  const seen = new Set<string>();

  for (const fk of fks) {
    const from = tables.get(fk.fromTable);
    const to = tables.get(fk.toTable);

    if (!from || !to) {
      result.warnings.push(
        `Skipped foreign key ${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}: table not found.`,
      );
      continue;
    }

    const fromColumn = from.columns.find(
      (c) => c.name.toLowerCase() === fk.fromColumn.toLowerCase(),
    );
    // Default to the target's primary key when the DDL omits the column.
    const toColumn = fk.toColumn
      ? to.columns.find((c) => c.name.toLowerCase() === fk.toColumn!.toLowerCase())
      : to.columns.find((c) => c.pk);

    if (!fromColumn || !toColumn) {
      result.warnings.push(
        `Skipped foreign key ${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}: column not found.`,
      );
      continue;
    }

    fromColumn.fk = true;

    const id = `${from.id}.${fromColumn.name}->${to.id}.${toColumn.name}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // A unique FK is one-to-one; otherwise many rows point at one parent.
    const cardinality: Cardinality =
      fk.unique || fromColumn.unique || fromColumn.pk ? "1-1" : "n-1";

    result.edges.push({
      id,
      source: from.id,
      target: to.id,
      sourceHandle: columnHandleId(fromColumn.id, "r"),
      targetHandle: columnHandleId(toColumn.id, "l"),
      type: "relation",
      data: { kind: "relation", cardinality },
    } satisfies ArchEdge);
  }

  return result;
};
