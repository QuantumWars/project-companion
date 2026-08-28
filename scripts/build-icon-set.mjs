#!/usr/bin/env node
/**
 * Builds the offline icon subset for the architecture canvas.
 *
 * The `@iconify-json/*` packages are 4-7 MB each and are devDependencies for
 * exactly that reason: shipping them would dwarf the app. This script pulls
 * only the icons the catalog actually references into a single collection that
 * the canvas loads as one lazy chunk.
 *
 * It also decides each icon's licence, which the renderer enforces:
 *   - the source set's licence (devicon MIT, logos/simple-icons CC0, gcp Apache-2.0)
 *   - upgraded to `vendor-restricted` for anything carrying a cloud `provider`,
 *     because AWS/Azure/Google icon terms forbid recolouring, rotating or
 *     cropping their marks regardless of how the SVG set is licensed.
 *
 * Run: npm run build:icons
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIconData } from "@iconify/utils";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const CATALOG = resolve(ROOT, "lib/arch/tech-catalog.json");
const OUT = resolve(ROOT, "lib/arch/icons/icon-data.json");

/** Source set -> SPDX licence, and the load order for the fallback chain. */
const SETS = {
  devicon: { pkg: "@iconify-json/devicon/icons.json", license: "mit" },
  logos: { pkg: "@iconify-json/logos/icons.json", license: "cc0" },
  "simple-icons": { pkg: "@iconify-json/simple-icons/icons.json", license: "cc0" },
  gcp: { pkg: "@iconify-json/gcp/icons.json", license: "apache-2.0" },
};

const loaded = {};
for (const [prefix, { pkg }] of Object.entries(SETS)) {
  loaded[prefix] = JSON.parse(
    readFileSync(resolve(ROOT, "node_modules", pkg), "utf8"),
  );
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));

/** Tries the declared icon first, then the same id across the other sets. */
const candidatesFor = (tech) => {
  const list = [];
  if (tech.icon) list.push(tech.icon);
  for (const prefix of Object.keys(SETS)) list.push(`${prefix}:${tech.id}`);
  return list;
};

const icons = {};
const meta = {};
const missing = [];
const substituted = [];

let generic = 0;

for (const tech of catalog) {
  // Generic primitives (load balancer, cron, firewall...) have no brand mark;
  // the renderer draws those with a lucide glyph instead.
  if (!tech.icon) {
    generic++;
    continue;
  }

  let resolved = null;

  for (const candidate of candidatesFor(tech)) {
    const [prefix, name] = candidate.split(":");
    const set = loaded[prefix];
    if (!set) continue;

    const data = getIconData(set, name);
    if (data?.body) {
      resolved = { prefix, name, data };
      break;
    }
  }

  if (!resolved) {
    missing.push(tech.id);
    continue;
  }

  if (tech.icon && `${resolved.prefix}:${resolved.name}` !== tech.icon) {
    substituted.push(`${tech.id}: ${tech.icon} -> ${resolved.prefix}:${resolved.name}`);
  }

  icons[tech.id] = {
    body: resolved.data.body,
    width: resolved.data.width ?? 24,
    height: resolved.data.height ?? 24,
  };

  meta[tech.id] = {
    source: `${resolved.prefix}:${resolved.name}`,
    // A vendor's own terms outrank the SVG set's licence.
    license: tech.provider ? "vendor-restricted" : SETS[resolved.prefix].license,
  };
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    { collection: { prefix: "arch", icons, width: 24, height: 24 }, meta },
    null,
    0,
  ),
);

const bytes = readFileSync(OUT).length;
console.log(`catalog entries : ${catalog.length}`);
console.log(`icons resolved  : ${Object.keys(icons).length}`);
console.log(`generic (lucide): ${generic}`);
console.log(`output          : ${(bytes / 1024).toFixed(0)} KB  ${OUT.replace(ROOT + "/", "")}`);

const restricted = Object.values(meta).filter((m) => m.license === "vendor-restricted").length;
console.log(`vendor-restricted: ${restricted}`);

if (substituted.length) {
  console.log(`\nfell back to another set (${substituted.length}):`);
  for (const s of substituted) console.log("  " + s);
}

if (missing.length) {
  console.error(`\nNO ICON FOUND for ${missing.length}: ${missing.join(", ")}`);
  process.exit(1);
}
