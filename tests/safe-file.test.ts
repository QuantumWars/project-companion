/**
 * Bug 54b4e811: the paths of `lib/project/safe-file.ts` and its readers that `tests/bug-54b4e811.test.ts`
 * does not reach. Nothing here opens a FIFO or a device, so every call runs in this process.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundlePath, emptyBundle, readBundle } from "@/lib/project/bundle";
import { readShard } from "@/lib/project/events";
import { replaceFile } from "@/lib/project/safe-file";
import { eq, ok, test, throws, runAll } from "./harness";

const tmpProject = () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-safe-file-")));
  const root = join(parent, "project");
  mkdirSync(root, { recursive: true });
  return { parent, root, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
};

test("54b4e811: a shard or .project that is a symlink to a regular file outside the root is not read", () => {
  const { parent, root, cleanup } = tmpProject();
  try {
    const shard = join(parent, "outside.jsonl");
    writeFileSync(shard, `${JSON.stringify({ kind: "task.created", ts: 1, actor: "deadbeefcafe", seq: 1 })}\n`);
    mkdirSync(join(root, ".project-log"));
    symlinkSync(shard, join(root, ".project-log", "deadbeefcafe.jsonl"));
    eq(readShard(root, "deadbeefcafe"), [], "a shard outside the root counts as missing");

    const bundle = join(parent, "outside.project");
    writeFileSync(bundle, JSON.stringify(emptyBundle("Outside")));
    symlinkSync(bundle, bundlePath(root));
    eq(readBundle(root), null, "a .project outside the root counts as missing");
  } finally {
    cleanup();
  }
});

test("54b4e811: a shard that is a folder counts as missing, not an error", () => {
  const { root, cleanup } = tmpProject();
  try {
    mkdirSync(join(root, ".project-log", "deadbeefcafe.jsonl"), { recursive: true });
    eq(readShard(root, "deadbeefcafe"), [], "a folder at a shard's name is not opened");
  } finally {
    cleanup();
  }
});

test("54b4e811: replaceFile removes a symlink at its temp path and still writes the target", () => {
  const { parent, root, cleanup } = tmpProject();
  try {
    const target = join(root, "data.txt");
    const tmp = `${target}.${process.pid}.tmp`;
    const outside = join(parent, "keep.txt");
    writeFileSync(outside, "keep\n");
    symlinkSync(outside, tmp);

    replaceFile(target, "new\n");

    eq(readFileSync(target, "utf8"), "new\n", "the target has the new text");
    eq(lstatSync(target).isFile(), true, "the target is a regular file, not the planted symlink");
    eq(existsSync(tmp), false, "no temp file is left");
    eq(readFileSync(outside, "utf8"), "keep\n", "the symlink's target is unchanged");
  } finally {
    cleanup();
  }
});

test("54b4e811: replaceFile passes on an error that is not EEXIST", () => {
  const { root, cleanup } = tmpProject();
  try {
    const target = join(root, "missing-folder", "data.txt");
    throws(() => replaceFile(target, "new\n"), /ENOENT/, "a missing folder gives ENOENT");
    ok(!existsSync(target), "nothing is written");
  } finally {
    cleanup();
  }
});

test("54b4e811: replaceFile stops when it cannot remove its temp path, and leaves the target as it was", () => {
  const { root, cleanup } = tmpProject();
  try {
    const target = join(root, "data.txt");
    writeFileSync(target, "keep\n");
    mkdirSync(`${target}.${process.pid}.tmp`); // unlink refuses a folder: EPERM on macOS, EISDIR on Linux

    throws(() => replaceFile(target, "new\n"), /EPERM|EISDIR/, "a folder at the temp path is an error");
    eq(readFileSync(target, "utf8"), "keep\n", "the target is unchanged");
  } finally {
    cleanup();
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
