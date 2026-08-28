#!/usr/bin/env node
/**
 * Bundles each tests/*.test.ts with esbuild and runs it in a fresh process.
 *
 * A fresh process per file matters: these tests touch the filesystem and a
 * module-level cache leaking between suites is exactly the kind of order
 * dependence that makes a suite lie.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv[2];

const files = readdirSync(join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!files.length) {
  console.error(only ? `No test file matches "${only}"` : "No tests found.");
  process.exit(1);
}

// Bundles go inside the repo, not a temp dir: `packages: "external"` leaves
// imports bare, and Node resolves those relative to the FILE, so a bundle in
// /tmp cannot see node_modules.
const out = join(ROOT, "node_modules", ".archboard-tests");
mkdirSync(out, { recursive: true });
let failed = 0;

try {
  for (const file of files) {
    const bundle = join(out, file.replace(/\.ts$/, ".mjs"));
    await esbuild.build({
      entryPoints: [join(ROOT, "tests", file)],
      outfile: bundle,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      packages: "external",
      alias: { "@": ROOT },
      logLevel: "warning",
    });

    process.stdout.write(`\n${file}\n`);
    try {
      execFileSync(process.execPath, [bundle], { stdio: "inherit", cwd: ROOT });
    } catch {
      failed++;
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
