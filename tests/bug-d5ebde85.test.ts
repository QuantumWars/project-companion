/**
 * Regression test for bug d5ebde85 (SR-8): the artifact text lookup can be
 * slow without limit.
 *
 * `hashArtifact` builds the file path with `join(root, ref)` and then reads
 * whatever is there. `join` happily resolves a `..` segment, so an artifact
 * ref recorded in a merged log can name a file outside the project root. The
 * fix (SR-8) is to accept only artifact paths that are regular files inside
 * the project root. This test uses the fastest-failing shape of the bug: a
 * `..` ref that points at an ordinary, small file one directory above the
 * project root. Today that file is read and hashed; after the fix it must
 * not be read at all, so `hashArtifact` must treat it the same as a missing
 * artifact and return `null`.
 *
 * Deliberately not covered here (would need a child process with its own
 * kill timeout, never run in-process): a `..` ref to a device such as
 * `/dev/zero`, or to a FIFO with no reader. Those are the same path-escape
 * bug; this test only needs one fast-failing case to prove it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mutateBundle } from "@/lib/project/bundle";
import { hashArtifact } from "@/lib/project/gate";
import { readRoadmap } from "@/lib/project/roadmap";
import { initProject } from "@/lib/project/store";
import { eq, test, runAll } from "./harness";

test("d5ebde85: an artifact path outside the project root is not read", () => {
  const parent = mkdtempSync(join(tmpdir(), "pc-d5ebde85-"));
  const root = join(parent, "project");
  mkdirSync(root, { recursive: true });
  try {
    // A file that sits next to the project root, not inside it.
    writeFileSync(join(parent, "secret.txt"), "outside the project root\n");

    const escaped = hashArtifact(root, "../secret.txt");
    eq(escaped, null, "a ref that escapes the project root must not be read or hashed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("d5ebde85: a folder, a symlink out of the root and an escaped PRD source give null", () => {
  const parent = mkdtempSync(join(tmpdir(), "pc-d5ebde85-"));
  const root = join(parent, "project");
  mkdirSync(join(root, "docs"), { recursive: true });
  try {
    writeFileSync(join(parent, "secret.md"), "## Phase: Alerts\n");
    symlinkSync(join(parent, "secret.md"), join(root, "docs", "link.md"));
    eq(hashArtifact(root, "docs"), null, "a folder inside the root is not a regular file");
    eq(hashArtifact(root, "docs/link.md"), null, "a symlink that leaves the root is not read");
    eq(hashArtifact(root, "prd-section:alerts", "../secret.md"), null, "a PRD source outside the root is not read");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("d5ebde85: a PRD source outside the project root or not a regular file is not read", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-d5ebde85-")));
  const root = join(parent, "project");
  mkdirSync(join(root, "docs"), { recursive: true });
  try {
    initProject(root, "Demo");
    writeFileSync(join(parent, "outside.md"), "# Outside\n\n## Phase: Alerts\n");
    writeFileSync(join(root, "inside.md"), "# Inside\n\n## Phase: Alerts\n");
    const present = (source: string) => {
      mutateBundle(root, (b) => { b.prdSource = source; }); // as a merged .project could name it
      return readRoadmap(root).present;
    };
    eq(present("../outside.md"), false, "a PRD source outside the root is not read");
    eq(present("docs"), false, "a folder as the PRD source is not read");
    eq(present("inside.md"), true, "a PRD source inside the root is still read (control)");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("d5ebde85: an artifact path inside the project root is still read (control)", () => {
  const parent = mkdtempSync(join(tmpdir(), "pc-d5ebde85-"));
  const root = join(parent, "project");
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, "a.md"), "inside the project root\n");

    const inside = hashArtifact(root, "a.md");
    eq(typeof inside, "string", "an ordinary artifact inside the root is still hashed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
