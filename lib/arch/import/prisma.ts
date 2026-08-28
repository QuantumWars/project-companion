/**
 * Prisma schema -> ER diagram.
 *
 * Prisma models a relation twice: a scalar FK field plus an object field
 * carrying `@relation(fields: [...], references: [...])`. Only the scalar
 * becomes a column; the object field supplies the edge and is not drawn.
 */

import { emptyImport, type ImportResult } from "./types";
import type { ArchEdge, ArchNode, Cardinality, Column } from "@/types/arch";
import { columnHandleId } from "@/types/arch";

const SCALARS = new Set([
  "String", "Boolean", "Int", "BigInt", "Float", "Decimal",
  "DateTime", "Json", "Bytes", "Unsupported",
]);

type ParsedModel = {
  id: string;
  name: string;
  columns: Column[];
  /** Object fields that declare a relation. */
  relations: {
    target: string;
    fields: string[];
    references: string[];
    list: boolean;
    optional: boolean;
  }[];
  /** Object fields pointing back with no `@relation` -- the "many" side. */
  backRefs: { target: string; list: boolean }[];
};

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const listArg = (attrs: string, key: string): string[] => {
  const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(attrs);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

export const parsePrismaSchema = (schema: string): ImportResult => {
  const result = emptyImport();
  const text = stripComments(schema);

  // Enum-typed fields are columns, not relations, so the enum names have to be
  // known before any model body is read.
  const enums = new Set<string>();
  const enumRe = /enum\s+(\w+)\s*\{/g;
  let enumMatch: RegExpExecArray | null;
  while ((enumMatch = enumRe.exec(text)) !== null) {
    enums.add(enumMatch[1]);
  }

  const models = new Map<string, ParsedModel>();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;

  while ((match = modelRe.exec(text)) !== null) {
    const name = match[1];
    const model: ParsedModel = {
      id: name.toLowerCase(),
      name,
      columns: [],
      relations: [],
      backRefs: [],
    };

    for (const rawLine of match[2].split("\n")) {
      const line = rawLine.trim();
      // Block attributes (@@id, @@index, @@unique) are not fields.
      if (!line || line.startsWith("@@")) continue;

      const field = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!field) continue;

      const [, fieldName, typeName, isList, isOptional, attrs] = field;

      if (SCALARS.has(typeName) || enums.has(typeName)) {
        // A scalar, or an enum -- both render as an ordinary column.
        model.columns.push({
          id: `${model.id}.${fieldName.toLowerCase()}`,
          name: fieldName,
          type: typeName + (isList ? "[]" : ""),
          pk: /@id\b/.test(attrs) || undefined,
          unique: /@unique\b/.test(attrs) || undefined,
          nullable: isOptional ? undefined : false,
        });
        continue;
      }

      // An object field: the other side of a relation.
      if (/@relation\s*\(/.test(attrs)) {
        const inner = /@relation\s*\(([\s\S]*?)\)/.exec(attrs)?.[1] ?? "";
        const fields = listArg(inner, "fields");
        const references = listArg(inner, "references");

        if (fields.length && references.length) {
          model.relations.push({
            target: typeName.toLowerCase(),
            fields,
            references,
            list: Boolean(isList),
            optional: Boolean(isOptional),
          });
          continue;
        }
      }

      model.backRefs.push({ target: typeName.toLowerCase(), list: Boolean(isList) });
    }

    models.set(model.id, model);
  }

  if (models.size === 0) {
    result.warnings.push("No `model` blocks found.");
    return result;
  }

  result.nodes = Array.from(models.values()).map(
    (model): ArchNode => ({
      id: model.id,
      type: "table",
      position: { x: 0, y: 0 },
      data: { kind: "table", label: model.name, columns: model.columns },
    }),
  );

  const seen = new Set<string>();

  for (const model of Array.from(models.values())) {
    for (const relation of model.relations) {
      const target = models.get(relation.target);
      if (!target) {
        result.warnings.push(
          `Skipped relation ${model.name} -> ${relation.target}: model not found.`,
        );
        continue;
      }

      const fromColumn = model.columns.find(
        (c) => c.name.toLowerCase() === relation.fields[0].toLowerCase(),
      );
      const toColumn =
        target.columns.find(
          (c) => c.name.toLowerCase() === relation.references[0].toLowerCase(),
        ) ?? target.columns.find((c) => c.pk);

      if (!fromColumn || !toColumn) {
        result.warnings.push(
          `Skipped relation ${model.name}.${relation.fields[0]} -> ${target.name}: field not found.`,
        );
        continue;
      }

      fromColumn.fk = true;

      const id = `${model.id}.${fromColumn.name}->${target.id}.${toColumn.name}`;
      if (seen.has(id)) continue;
      seen.add(id);

      // A unique FK means one-to-one; otherwise many children per parent.
      const cardinality: Cardinality =
        fromColumn.unique || fromColumn.pk ? "1-1" : "n-1";

      result.edges.push({
        id,
        source: model.id,
        target: target.id,
        sourceHandle: columnHandleId(fromColumn.id, "r"),
        targetHandle: columnHandleId(toColumn.id, "l"),
        type: "relation",
        data: { kind: "relation", cardinality },
      } satisfies ArchEdge);
    }
  }

  return result;
};
