/**
 * Regression test for bug d5ebde85 (SR-8): the artifact text lookup can be
 * slow without limit.
 *
 * `hashArtifact` builds the file path with `join(root, ref)` and then reads
 * whatever is there. `join` happily resolves a `..` segment, so an artifact
 * ref recorded in a merged log can name a file outside the project root. The
 * fix (SR-8) is to accept only artifact paths and a PRD source that are
 * regular files inside the project root. The first test uses the
 * fastest-failing shape of the bug: a `..` ref that points at an ordinary,
 * small file one directory above the project root. Before the fix that file
 * was read and hashed; now `hashArtifact` treats it as a missing artifact and
 * returns `null` without opening it. `prd init` (`createPrd`) must also never
 * write outside the root or over a file or a symlink.
 *
 * Deliberately not covered here (would need a child process with its own
 * kill timeout, never run in-process): a `..` ref to a device such as
 * `/dev/zero`, or to a FIFO with no reader. Those are the same path-escape
 * bug; this test only needs one fast-failing case to prove it.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mutateBundle } from "@/lib/project/bundle";
import { hashArtifact } from "@/lib/project/gate";
import { createPrd, readRoadmap } from "@/lib/project/roadmap";
import { initProject } from "@/lib/project/store";
import { eq, test, runAll, throws } from "./harness";

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
    symlinkSync("a.md", join(root, "link.md"));

    const inside = hashArtifact(root, "a.md");
    eq(typeof inside, "string", "an ordinary artifact inside the root is still hashed");
    eq(hashArtifact(root, "link.md"), inside, "a symlink to a file inside the root is still hashed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("d5ebde85: a Unix socket inside the project root gives null", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pc-d5ebde85-"));
  const server = createServer();
  try {
    await new Promise<void>((done) => server.listen(join(parent, "s"), done));
    eq(hashArtifact(parent, "s"), null, "a socket is not a regular file");
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(parent, { recursive: true, force: true });
  }
});

/** A project in a temp folder whose .project names `source` as the PRD source, as a merged .project could. */
const prdProject = (source: string): { parent: string; root: string } => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pc-d5ebde85-")));
  const root = join(parent, "project");
  mkdirSync(root);
  initProject(root, "Demo");
  mutateBundle(root, (b) => { b.prdSource = source; });
  return { parent, root };
};

test("d5ebde85: prd init never writes outside the root or over a file or a symlink", () => {
  const escaped = prdProject("../outside.md");
  const linked = prdProject("docs/prd.md");
  const fresh = prdProject("docs/prd.md");
  try {
    writeFileSync(join(escaped.parent, "outside.md"), "keep\n");
    throws(() => createPrd(escaped.root, "# PRD\n"), /is not inside the project/);
    eq(readFileSync(join(escaped.parent, "outside.md"), "utf8"), "keep\n", "the file outside the root changed");

    mkdirSync(join(linked.root, "docs"));
    writeFileSync(join(linked.parent, "target.md"), "keep\n");
    symlinkSync(join(linked.parent, "target.md"), join(linked.root, "docs", "prd.md"));
    throws(() => createPrd(linked.root, "# PRD\n"), /is not a regular file inside the project/);
    eq(readFileSync(join(linked.parent, "target.md"), "utf8"), "keep\n", "the symlink's target changed");

    eq(createPrd(fresh.root, "# PRD\n"), "docs/prd.md", "a missing docs/prd.md is created");
    eq(readFileSync(join(fresh.root, "docs", "prd.md"), "utf8"), "# PRD\n");
    throws(() => createPrd(fresh.root, "# PRD\n"), /already exists/);
  } finally {
    for (const p of [escaped, linked, fresh]) rmSync(p.parent, { recursive: true, force: true });
  }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
