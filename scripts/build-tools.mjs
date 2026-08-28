#!/usr/bin/env node
/**
 * Bundles the CLI and MCP server.
 *
 * Both import TypeScript from `lib/` using the project's `@/` alias, which
 * Node cannot resolve on its own -- esbuild handles the alias and the types in
 * one pass and emits plain Node ESM, so `npx` and Claude Code can run them
 * without a TypeScript loader.
 */

import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Keep node_modules external: bundling the MCP SDK would be slower to build
  // and harder to debug, and `npx` resolves them from the install anyway.
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  alias: { "@": ROOT },
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [resolve(ROOT, "cli/index.ts")],
  outfile: resolve(ROOT, "dist/project-companion.mjs"),
});

await build({
  ...common,
  entryPoints: [resolve(ROOT, "mcp/server.ts")],
  outfile: resolve(ROOT, "dist/project-companion-mcp.mjs"),
});

console.log("built dist/project-companion.mjs and dist/project-companion-mcp.mjs");
