# Bug: log shards and `.project` read through a symlink or device (SR-8 residual 3)

## Observed

`readShard` (`lib/project/events.ts:242-257`) and `readBundle` (`lib/project/bundle.ts:180-201`) read
whatever is at a shard's or `.project`'s path with no check on its kind:

```ts
export const readShard = (root: string, actor: string): ProjectEvent[] => {
  const path = shardPath(root, actor);
  if (!existsSync(path)) return [];
  // ... readFileSync(path, "utf8") ...
```

```ts
export const readBundle = (root: string): ProjectBundle | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(bundlePath(root), "utf8"));
```

`existsSync`/the try block only tests presence, not kind. `.project-log/` is populated by merging
other clones' shard files, and `.project` is a tracked file too, so either can arrive, through a
merged commit, as a symlink to a device (e.g. `/dev/zero`) or a FIFO with no writer. Opening that
with the blocking `readFileSync` above never returns -- the same hang SR-8 (bug d5ebde85) was
opened for, reached here through `D1` (the event log) and `D2` (`.project`) instead of a gate
artifact.

Separately, at low severity, the write-then-rename helpers for these same files write
`<path>.<pid>.tmp` with a plain `writeFileSync` (no `wx`), which follows a symlink already sitting
at that exact name: `writeText` (`lib/project/roadmap.ts:242-246`, reached through `editPrd`), the
inline write in `writeBundle` (`lib/project/bundle.ts:235-237`), and `writeJson`
(`lib/project/store.ts:219-223`, used directly and by `writeSidecar`).

## Expected

TH-7 residual 3 (`specs/decision-alerts/threat-model.md:117-123`):

> Log shards (`events.ts`) and `.project` (`bundle.ts`) are still read through a symlink or a
> device. Open: bug 54b4e811. That bug also covers the write-then-rename helpers: `writeText`
> (`lib/project/roadmap.ts:242-246`), `lib/project/bundle.ts:235-237` and `writeJson`
> (`lib/project/store.ts:220-223`). Each writes `<path>.<pid>.tmp` with a plain `writeFileSync`,
> which follows a symlink at that name. Fix: write the temp file with the `wx` flag.

This is the residual the PM left open at the PR 22 merge gate, card c-73ccab ("Accept 1 and 2; bug
for 3"; `specs/decision-alerts/threat-model.md:109-110`), after accepting TH-7 residuals 1 and 2 of
SR-8 -- the security-review finding that bugfix d5ebde85 fixed for gate artifacts and the PRD
source (`specs/bugs/d5ebde85/bugfix.md`).

Requirement ID: **UNKNOWN**, for the same reason bugfix d5ebde85 gave for SR-8 itself: TH-7 and
SR-8 are threat-model/security-review findings, approved at the decision-alerts design gate and the
PR 22 merge gate, not PRD/requirements acceptance criteria. I searched
`specs/decision-alerts/requirements.md` and `docs/prd.md` again and found no `DA-xx` criterion that
states a kind or location rule for the tracker's own files (log shards, `.project`, the PRD source,
or their temp-file writes). TH-7 residual 3 and card c-73ccab are the nearest approved source, and
stand in for a requirement ID here. This should be flagged to the PM/architect again when this bug
is built, same as bugfix d5ebde85 flagged it for SR-8.

## Steps to reproduce

1. Create a project (`project-companion init`, or `initProject(root, "Demo")`), so `.project`
   exists.
2. Create a FIFO next to the project (`mkfifo`), with no process ever opening it for writing.
3. Replace a log shard with a symlink to that FIFO (`mkdir .project-log`, then
   `ln -s <fifo> .project-log/<actor>.jsonl`); or, in a separate project, replace `.project` itself
   with a symlink to a (second) such FIFO.
4. Call `readShard(root, <actor>)` / `readEvents(root)` (or run `project-companion log`), or call
   `readBundle(root)` (or run `project-companion status`).
5. Observe: the call opens the FIFO for reading and never returns -- no error, no timeout, no
   output -- because no writer ever connects. (The bug report's own example, a symlink to
   `/dev/zero`, hangs the same way, by allocating memory without bound instead of blocking; see the
   regression test's file comment for the measurements behind using a FIFO instead.)
6. Separately, for the write side: create `.project` (or `docs/prd.md`, or any JSON file written
   through `writeJson`), then place a symlink at `<that path>.<pid>.tmp` (the writer's own pid)
   pointing at a file outside the project. Call `writeBundle`/`editPrd`/`writeJson`. Observe: the
   file outside the project is overwritten with the new content, because the plain `writeFileSync`
   on the temp path follows the symlink.

## Root cause

`readShard` and `readBundle` trust that the path named by `.project-log/`'s directory listing, or by
`.project`, is a plain file worth opening, and open it with a blocking `readFileSync` with no
`lstat`/`isFile()` check first -- the same gap `hashArtifact` had before bugfix d5ebde85, on two
files that fix did not touch. `writeText`, `writeBundle`'s inline write, and `writeJson` build a
temp path from the current pid and open it with a plain `writeFileSync`, which (like any `open()`
with no `O_NOFOLLOW` or `wx`) follows a symlink already sitting there instead of refusing it.

## Fix

**Reads.** Reuse `regularFileIn`/`isInside` (`lib/project/gate.ts:134-155`), the helper bugfix
d5ebde85 built for `hashArtifact` and `readPrdText`: resolve the shard/bundle path with it before
calling `readFileSync`, and treat `null` as "missing" -- `readShard` already returns `[]` for a
missing path, and `readBundle` already returns `null` from its `catch`, so neither caller's
contract changes. The exact call site needs the builder's judgement: a shard's path is already
known to be inside `.project-log/` (it comes from `readdirSync`, not a merged ref), so the check
may only need `lstatSync`/`isFile()` rather than the full containment check `regularFileIn` also
does for gate artifacts; `.project`'s path is fixed by `bundlePath(root)`, so the same applies there.

**Writes.** Follow `lib/project/notify-record.ts:65-71`'s model (open with `wx`, which never
follows a symlink) for the temp-file writes, exactly as bugfix d5ebde85's `createPrd` fix already
does for its own temp file: open the temp path with `{ flag: "wx" }`; on `EEXIST`, remove the temp
path (removing a symlink there, never its target) and retry with `wx`. Apply this to `writeText`
(`roadmap.ts:242-246`), the inline write in `writeBundle` (`bundle.ts:235-237`), and `writeJson`
(`store.ts:219-223`).

**Out of scope.** `lib/project/registry.ts:127` has the identical unguarded-temp-write pattern, but
it writes the global project index in the user's home folder, not a path a clone's merged commit
can touch, so TH-7 residual 3 and this spec both leave it out.

**Line estimate: about 40-60 changed lines.** Basis: 3-5 lines per read site (an
`lstat`/`isFile`-style guard ahead of the existing `readFileSync`, in `events.ts` and `bundle.ts`)
plus roughly 7-10 lines per write site for the "`wx`, catch `EEXIST`, unlink, retry `wx`" shape,
sized against the two landed examples of that exact shape: `notify-record.ts:65-71` (7 lines) and
bugfix d5ebde85's `createPrd` fix (`specs/bugs/d5ebde85/bugfix.md`, "Fix", item 5). Three write
sites (`roadmap.ts`, `bundle.ts`, `store.ts`) plus two read sites gives roughly 2x5 + 3x10 = 40, up
to 60 once tests and the two read sites' error handling are counted.

**Docs.** TH-7 residual 3 and the D1/D2 rows of `specs/decision-alerts/threat-model.md` are updated
when the fix lands. Not in this spec step.

## Regression test

`tests/bug-54b4e811.test.ts`, 6 tests:

- `54b4e811: a log shard that is a symlink to a FIFO with no writer is not read`
- `54b4e811: a .project that is a symlink to a FIFO with no writer is not read`
- `54b4e811: a symlink at .project's temp path does not redirect writeBundle's write`
- `54b4e811: a symlink at the PRD's temp path does not redirect editPrd's write`
- `54b4e811: a symlink at a JSON temp path does not redirect writeJson's write`
- `54b4e811: a plain write to .project, the PRD and a JSON file still succeeds (control)`

The first two cover Observed 1 (the hang), one for a log shard and one for `.project`. Each plants
a symlink to a FIFO with no writer, then calls `readShard`/`readBundle` inside a **second,
disposable process** (this test file, re-run with a helper flag) that the parent kills after a 3 s
timeout with `spawnSync`'s own `timeout` option -- so a hang fails as a clear assertion
(`timedOut: true`, "expected false, got true"), never a stuck test run. A device such as
`/dev/zero` was not used for the probe itself: measured locally, an unbounded
`readFileSync('/dev/zero')` allocates roughly 1.5-2 GB/s (≈1.4 GB RSS at 0.5 s, ≈4.7 GB at 2 s,
still climbing) before anything kills it, which risks the CI runner or the PM's Mac running low on
memory even inside a timeout; a FIFO with no writer blocks the same way (`open()` for reading never
returns) with flat memory (measured locally: ~38 MB RSS, the same as an idle `node`), so the probe
uses that instead. (`mkfifo` is already this codebase's way to make one --
`tests/notify.test.ts`'s TH-8 test -- and that test's skip-if-`mkfifo`-unavailable fallback is
reused here, so a machine without it skips rather than fails.)

The next three cover Observed 2 (the temp-file write), one per listed helper, with no race needed:
planting the symlink before calling the write function reproduces the bug deterministically. The
last test is the control: an ordinary write to each of `.project`, the PRD and a JSON file, with no
symlink in the way, still succeeds.

Before the fix, 5 of 6 fail; only the control passes:

```
$ npm test -- bug-54b4e811
...
bug-54b4e811.test.ts
  FAIL 54b4e811: a log shard that is a symlink to a FIFO with no writer is not read
       readShard must not block on a shard that is a symlink to a FIFO with no writer: expected false, got true
  FAIL 54b4e811: a .project that is a symlink to a FIFO with no writer is not read
       readBundle must not block on a .project that is a symlink to a FIFO with no writer: expected false, got true
  FAIL 54b4e811: a symlink at .project's temp path does not redirect writeBundle's write
       the file outside the root changed when the bundle was written: expected "keep\n", got "{\n  \"version\": 2, ...}\n"
  FAIL 54b4e811: a symlink at the PRD's temp path does not redirect editPrd's write
       the file outside the root changed when the PRD was written: expected "keep\n", got "# PRD\n\n## Phase: Alerts\n\n## Phase: New phase\n"
  FAIL 54b4e811: a symlink at a JSON temp path does not redirect writeJson's write
       the file outside the root changed when writeJson ran: expected "keep\n", got "{\n  \"hello\": \"world\"\n}\n"
  ok   54b4e811: a plain write to .project, the PRD and a JSON file still succeeds (control)

1/6 passed
```

Exit code: 1. Run time: ~6.5 s (the two FIFO probes each wait out their 3 s kill timeout before
reporting the hang; the fix should bring this back down to about 1 s).
