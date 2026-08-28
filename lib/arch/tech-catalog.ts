/**
 * The technology catalog behind the node palette.
 *
 * The raw entries live in `tech-catalog.json` so that both this module and
 * `scripts/build-icon-set.mjs` (plain Node, no TS toolchain) read one source
 * of truth. The build script resolves each `icon` against the bundled Iconify
 * sets and emits the offline subset.
 */

import rawCatalog from "./tech-catalog.json";
import type { CloudProvider } from "@/types/arch";

export type TechCategory =
  | "language"
  | "frontend"
  | "backend"
  | "database"
  | "cache"
  | "queue"
  | "infra"
  | "cloud"
  | "observability"
  | "cicd"
  | "auth"
  | "ai"
  | "data"
  | "edge"
  | "saas"
  | "generic";

export type TechDef = {
  id: string;
  label: string;
  category: TechCategory;
  /** Brand colour. Used for the node's accent only -- never to tint the icon. */
  color: string;
  /**
   * Iconify name resolved at build time. Absent for generic primitives
   * (load balancer, cron, firewall...), which render a lucide glyph instead.
   */
  icon?: string;
  aliases?: string[];
  provider?: CloudProvider;
};

export const TECH_CATALOG = rawCatalog as unknown as TechDef[];

const BY_ID = new Map(TECH_CATALOG.map((tech) => [tech.id, tech]));

export const getTech = (id: string | undefined): TechDef | undefined =>
  id ? BY_ID.get(id) : undefined;

export const CATEGORY_LABELS: Record<TechCategory, string> = {
  language: "Languages",
  frontend: "Frontend",
  backend: "Backend",
  database: "Databases",
  cache: "Caching",
  queue: "Queues & streaming",
  infra: "Infrastructure",
  cloud: "Cloud services",
  observability: "Observability",
  cicd: "CI/CD",
  auth: "Auth",
  ai: "AI & ML",
  data: "Data",
  edge: "Edge & hosting",
  saas: "Third-party",
  generic: "Generic",
};

/** Category display order in the palette: generic primitives first. */
export const CATEGORY_ORDER: TechCategory[] = [
  "generic",
  "frontend",
  "backend",
  "database",
  "cache",
  "queue",
  "infra",
  "cloud",
  "edge",
  "observability",
  "cicd",
  "auth",
  "ai",
  "data",
  "language",
  "saas",
];

/**
 * Ranked search over label, id and aliases. Prefix matches beat substring
 * matches so typing "post" puts PostgreSQL above "Cloud Post-processing".
 */
export const searchTech = (query: string, limit = 60): TechDef[] => {
  const q = query.trim().toLowerCase();

  if (!q) {
    return TECH_CATALOG.slice(0, limit);
  }

  const scored: { tech: TechDef; score: number }[] = [];

  for (const tech of TECH_CATALOG) {
    const label = tech.label.toLowerCase();
    const id = tech.id.toLowerCase();

    let score = -1;
    if (label === q || id === q) score = 0;
    else if (label.startsWith(q) || id.startsWith(q)) score = 1;
    else if (tech.aliases?.some((a) => a.startsWith(q))) score = 2;
    else if (label.includes(q) || id.includes(q)) score = 3;
    else if (tech.aliases?.some((a) => a.includes(q))) score = 4;

    if (score >= 0) {
      scored.push({ tech, score });
    }
  }

  scored.sort((a, b) => a.score - b.score || a.tech.label.localeCompare(b.tech.label));
  return scored.slice(0, limit).map((s) => s.tech);
};
