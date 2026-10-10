# Bug: the artifact text lookup can be slow without limit (SR-8)

## Observed

`hashArtifact` (`lib/project/gate.ts:134`) builds the artifact's file path with `join(root, ref)` and then reads
whatever is at that path with no check on its kind, size or location:

```ts
const file = join(root, ref);
return existsSync(file) ? sha(readFileSync(file, "utf8")) : null;
```

The PRD-source path used for `prd-section:` refs (`gate.ts:137`, `join(root, prdPath)`) has the same shape. A
gate's `artifacts` list comes from a merged event log (`.project-log/`), so a ref can be anything a clone chose to
write: a path with `..` that leaves the project root, a path to a very large file, or a path to a device such as
`/dev/zero`. `readGates`/`withStaleness` (`gate.ts:235`) call `hashArtifact` for every approved artifact on every
read, and `requestGate` (`gate.ts:248`) calls it for every requested artifact. So:

- `gate request` has always re-hashed artifacts this way (`gate.ts:257` in the design doc's line numbering).
- Since PR #17 (decision-alerts, SR-8), `card open` reaches the same lookup through `readCockpit`, because the
  notification text needs the cockpit's `needsYou` list, which calls `readGates`.

Either command can become slow without limit, or never return, depending on what a merged log named.

`readPrdText` (`lib/project/roadmap.ts:87-95`, reached by `cockpit` and `card open`) reads the PRD source named
in `.project` the same unchecked way.

## Expected

The approved fix, from security review SR-8 (`specs/decision-alerts/reviews/security.md:108-113,160-161`) and
design section 6, step 5 (`specs/decision-alerts/design.md:513-518`), both approved at the decision-alerts design
gate (2026-10-08/09):

> accept only artifact paths and a PRD source that are regular files inside the project root.

Concretely: `hashArtifact` must resolve `join(root, ref)` (and `join(root, prdPath)`), check that the resolved
path stays inside `root`, and check that it names a regular file (not a directory, device, FIFO, socket or
symlink to one) before reading it. A ref that fails either check must be treated the same as a missing artifact:
`hashArtifact` returns `null`, not a hash and not a thrown error. That keeps the existing contracts in
`requestGate` (`gate.ts:248-252`, a `null` hash becomes "these artifacts do not exist") and in `withStaleness`
(`gate.ts:224-233`, a `null` hash where one was approved makes the gate `stale`) unchanged; only the file-reading
rule inside `hashArtifact` changes.

Requirement ID: **UNKNOWN**. SR-8 is a security-review finding, approved as part of the decision-alerts design
gate, not a PRD/requirements acceptance criterion. I searched `specs/decision-alerts/requirements.md` and
`docs/prd.md` for an EARS criterion (a `DA-xx` id) that states a size, kind or location rule for gate artifacts,
and found none — only the two existing criteria that assume the lookup succeeds (DA-02.5: "the notifier shall
append no gate, track or card event to the event log"; DA-04.1: the notification record). The nearest named
source is the SR-8 finding itself and design.md section 6 step 5. This should be flagged to the PM/architect:
either SR-8 gets a criterion id when this bug is specced for build, or the PRD/requirements doc is the wrong
place to look and the EM should say where the id lives.

## Steps to reproduce

1. Create a project root directory, and a sibling file one directory above it (e.g. `<parent>/secret.txt`, with
   `<root>` at `<parent>/project`).
2. Call `hashArtifact(root, "../secret.txt")` (or, through the CLI, request or approve a gate whose artifact list
   has been edited in `.project-log/` to include a `..` ref, then run `gate request`, `gate status` or `card
   open`).
3. Observe: the sibling file is read and hashed; `hashArtifact` returns its sha256, not `null`. Nothing refuses
   the read or the request, even though the file is outside the project root.
4. For the slow/never-ending half of this bug (not exercised by the regression test below, to keep the test
   fast and safe): point the same kind of `..` ref at a very large file or at a device such as `/dev/zero`.
   `gate request`, `gate status`/`readGates`, and since PR #17 `card open`, all run `hashArtifact` on it and can
   run for a very long time or never return.
5. (PR #22 review H1/security F1) `prd init` (`cli/index.ts`, now `createPrd` in `lib/project/roadmap.ts`) wrote
   to the PRD source path with no containment or symlink check either, so it could overwrite a file outside the
   root, or a symlink's target, even once `readPrdText` refused to read from there.

## Root cause

`hashArtifact` trusts `ref` (and `prdPath`) as a plain relative path and joins it onto `root` with no
containment check and no check that the resolved path is a regular file. `join()` normalises `..` segments
instead of rejecting them, so a ref that walks out of `root` resolves to a real path on disk, which is then
opened and read in full. The same two gaps (no containment check, no file-kind/size check) also let an
in-project directory raise `EISDIR` from `readFileSync` instead of being rejected before the read
(`tests/notify.test.ts`'s existing `TH-5: a folder in place of an approved artifact gives lookup failed: EISDIR`
tests, in-process and CLI, depend on that `EISDIR` throw and must be updated by whoever builds this fix, per
design.md:453 and the task's source note). `readPrdText` (`lib/project/roadmap.ts:87-95`) has the same two gaps.

## Fix

Change `hashArtifact` (`lib/project/gate.ts:134`) to, for both the plain-path branch and the `prd-section:`
branch's `join(root, prdPath)`:
1. Resolve `root` and the joined path to absolute, real paths.
2. Return `null` if the resolved path is not equal to, or inside, the resolved `root` (containment check, fixes
   the `..` escape).
3. Return `null` if the path does not exist, or exists but is not a regular file (fixes directories, devices,
   FIFOs and similar), without calling `readFileSync` on it first.
4. Only then read and hash the file.

This is mostly a pure change inside `hashArtifact`; `requestGate`, `approveGate` and `withStaleness` already
treat a `null` hash as "missing"/"changed". One caller did need to change: `prd init`/`createPrd` (item 5 above)
now refuses a source whose nearest existing folder is outside the root, and writes with `wx` (never over a file,
never through a symlink). This fix also updated the two tests named in the task source (`tests/notify.test.ts`,
the TH-5 `EISDIR` case, in-process and CLI) for the new, non-throwing behaviour, and the DA-02.5
approved-artifact case; both the code and these test updates landed in this pull request (PR #22).

`readPrdText` must use the same check: the builder exported `regularFileIn` from `gate.ts` and had
`readPrdText` (`lib/project/roadmap.ts`) reuse it, so the PRD source gets the same in-root, regular-file rule
(card c-3a9ce2).

## Regression test

`tests/bug-d5ebde85.test.ts`, 6 tests:

- `d5ebde85: an artifact path outside the project root is not read`
- `d5ebde85: a folder, a symlink out of the root and an escaped PRD source give null`
- `d5ebde85: a PRD source outside the project root or not a regular file is not read`
- `d5ebde85: an artifact path inside the project root is still read (control)` (now also an in-root symlink)
- `d5ebde85: a Unix socket inside the project root gives null`
- `d5ebde85: prd init never writes outside the root or over a file or a symlink`

Before the fix, only two of these six tests existed: the first
(`d5ebde85: an artifact path outside the project root is not read`) and the fourth
(`d5ebde85: an artifact path inside the project root is still read (control)`); the control did not yet cover
an in-root symlink.

```
$ npm test -- bug-d5ebde85
...
bug-d5ebde85.test.ts
  FAIL d5ebde85: an artifact path outside the project root is not read
       a ref that escapes the project root must not be read or hashed: expected null, got "e49bf04700b9ea7138b674431f343167a6601c87973af88e42d15d4c962c3855"
  ok   d5ebde85: an artifact path inside the project root is still read (control)

1/2 passed
```
Exit code: 1.
