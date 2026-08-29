import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteProject, initProject, createDiagram, projectPaths } from "@/lib/project/store";
import { eq, ok, runAll, test } from "./harness";

/**
 * Deleting a store is the only operation here that removes a directory, and it
 * runs inside a repository full of somebody's source. These tests exist to
 * prove it cannot reach anything it was not pointed at.
 */

const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-delete-")));
  initProject(dir, "Doomed");
  createDiagram(dir, "Something", "architecture");
  // Source that must survive: the store lives inside a real repository.
  writeFileSync(join(dir, "important.ts"), "export const keep = true;\n", "utf8");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "// keep me\n", "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("deletes the store and reports what went", () => {
  const { dir, cleanup } = project();
  try {
    const paths = projectPaths(dir);
    ok(existsSync(paths.dir), "store exists before");

    const result = deleteProject(dir);
    ok(result !== null, "returns a summary");
    eq(result!.diagrams, 1);
    eq(result!.removed, paths.dir);
    ok(!existsSync(paths.dir), "store is gone");
  } finally {
    cleanup();
  }
});

test("never touches anything outside the store", () => {
  const { dir, cleanup } = project();
  try {
    deleteProject(dir);
    ok(existsSync(join(dir, "important.ts")), "a file beside the store survives");
    ok(existsSync(join(dir, "src", "app.ts")), "source directories survive");
    ok(existsSync(dir), "the repository itself survives");
  } finally {
    cleanup();
  }
});

test("refuses a directory that is not a store", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-notastore-")));
  try {
    writeFileSync(join(dir, "precious.txt"), "do not delete", "utf8");
    eq(deleteProject(dir), null, "no project.json means no deletion");
    ok(existsSync(join(dir, "precious.txt")), "the directory is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a child directory of a project", () => {
  const { dir, cleanup } = project();
  try {
    // `findProject` walks UP, so a subdirectory resolves to the parent's store.
    // Deleting from there would be a surprise, so the root must match exactly.
    const child = join(dir, "src");
    eq(deleteProject(child), null, "only the project root may delete itself");
    ok(existsSync(projectPaths(dir).dir), "the store survives");
  } finally {
    cleanup();
  }
});

test("deleting twice is not an error the second time", () => {
  const { dir, cleanup } = project();
  try {
    ok(deleteProject(dir) !== null, "first call removes it");
    eq(deleteProject(dir), null, "second call finds nothing to remove");
  } finally {
    cleanup();
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
