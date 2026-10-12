# Bug: readJson reads the older store files with no regular-file check, and the .project folder fallback (task 49c078ce)

## Observed

Checked in the code at head `469df0c`.

1. `readJson` (`lib/project/store.ts:211-217`) is `JSON.parse(readFileSync(path, "utf8"))` inside a `try`. It has no
   check on what is at `path`. A merged commit can put a symlink to a FIFO or a device where an older-layout file
   should be (`.claude/project-companion/tasks.json`, `project.json`, `roadmap.json`, `diagrams/<id>.json`,
   `boards/<id>.json`). The read opens it and blocks, the same hang as SR-8 (bug d5ebde85) and bug 54b4e811.
   Projects that still use the older layout (`isLegacyStore(storeDir)`, `store.ts:165`) are exposed. A symlink
   only has to be committed (`core.symlinks=true` on the clone that merges it).
2. When a merged commit makes `.project` a FOLDER (or a symlink to a folder), `findProject` still answers
   `storeDir = ".project"`, because `discover` (`store.ts:147`) tests only `existsSync`. `readBundle` gives null
   (`regularFileIn` refuses a folder). `readSidecar` (`lib/project/roadmap.ts:74-86`) then reads
   `projectPaths(root).roadmap`, which is `<root>/.project/roadmap.json`, through `readJson`. A symlink there to a
   FIFO or a device hangs `readRoadmap`, which is the first call of `readCockpit` (`cockpit.ts:336`), which the
   notify path runs for every decision command.
3. The write side: `writeSidecar` (`roadmap.ts:247-259`) tries `mutateBundle`, which returns null when there is no
   readable bundle, and falls back to `writeJson(projectPaths(root).roadmap, file)`. `writeJson` runs
   `mkdirSync(dirname)` and `replaceFile`. If `.project` is a symlink to a folder outside the root, the write lands
   there (the parent folder is followed; the 54b4e811 fix covers only the temp name). Callers: `editPrd`,
   `setFeatureOverride`, `setPhase` and `setPrdSource` (`roadmap.ts:215, 274, 301, 349`). With a real `.project`
   folder, a stray `roadmap.json` is created inside it.

Reproduced by `tests/bug-49c078ce.test.ts` (see Regression test).

## Expected

No requirement ID exists: **UNKNOWN**. The nearest sources are TH-7 residual 3 (the "open" bullet about the
`.project` folder fallback, `specs/decision-alerts/threat-model.md`) and the security review of bugfix 54b4e811,
finding F2 (card c-4936f7). The expected behaviour, from the task and the security review:

- A read of a tracker file takes only a regular file. Anything else (symlink to a device or FIFO, folder, missing)
  gives the caller's fallback, with no blocking read.
- The legacy `roadmap.json` is used only when the project really uses the older layout (`isLegacyStore(storeDir)`
  is true). When `.project` exists but is not a readable bundle, a read gives `emptyRoadmap()` and a write throws a
  "No .project" error (the same message `requireBundle` uses, `store.ts:612`). Nothing is written under `.project`
  and nothing is written through a linked `.project`.
- Projects that still use the older layout keep working: reads, writes and `migrate` are unchanged for regular
  files.

## Steps to reproduce

1. Make a temporary root. Run `mkfifo <parent>/roadmap.fifo`.
2. Make `<root>/.project` a folder. Symlink `<root>/.project/roadmap.json` to the FIFO.
3. Call `readRoadmap(root)` (or `project-companion cockpit`). It never returns. The test kills it after 3 seconds.
4. For the older layout: make `<root>/.claude/project-companion/project.json` (a normal file) and symlink
   `tasks.json` (or `diagrams/d1.json`) to a FIFO. `readTasks(root)` or `readDiagram(root, "d1")` never returns.
5. For the write: symlink `<root>/.project` to a folder outside the root. Call `setPrdSource(root, "docs/other.md")`.
   `<outside>/roadmap.json` now exists.

## Root cause

`readJson` trusts its path. The 54b4e811 fix put the kind check into `regularFileIn` and used it for shards and
`.project`, but `readJson` and its callers were left alone. `readSidecar` and `writeSidecar` treat "no readable
bundle" as "older layout" without asking `isLegacyStore`; `projectPaths(root).roadmap` is `<root>/.project/roadmap.json`
whenever `storeDir` is `.project`. `writeJson` follows the parent folder.

## Fix

### Callers (head `469df0c`)

`readJson` callers:

| File:line | What it reads | In scope |
|---|---|---|
| `lib/project/store.ts:271` | `project.json` (`legacyReadProject`) | yes, through `readJson` |
| `lib/project/store.ts:299` | `diagrams/<id>.json` (`legacyReadDiagram`; `existsSync` first, which follows a FIFO) | yes |
| `lib/project/store.ts:382` | each `*.json` in `diagrams/` and `boards/` (`reindexDiagrams` scan) | yes |
| `lib/project/store.ts:465` | `boards/<id>.json` (`legacyReadWhiteboard`) | yes |
| `lib/project/store.ts:557` | `roadmap.json` during `migrate` (`paths.roadmap`; legacy storeDir only) | yes |
| `lib/project/store.ts:1606` | `tasks.json` (`legacyReadTasks`) | yes |
| `lib/project/roadmap.ts:85` | `roadmap.json` in `readSidecar` (the `.project` folder fallback) | yes, plus the `isLegacyStore` gate |
| `lib/project/git-view.ts:73` | `.project-cache/git.json` (derived, gitignored) | yes, through `readJson`; no other change |

Other plain `readFileSync` in `lib/project/*.ts` and `cli/index.ts`:

| File:line | What it reads | In scope |
|---|---|---|
| `bundle.ts:184`, `events.ts:259`, `gate.ts:139, 143`, `roadmap.ts:93` | after `regularFileIn` | no, already safe |
| `events.ts:198` | `<root>/.git/config` and `$HOME/.gitconfig` | no: not merged content (`.git` is not tracked) |
| `registry.ts:112` | the global index under `$HOME` | no: not merged content |
| `notify-record.ts:89` | the notify record (`recordPath`, `notify-record.ts:20`) | no: local file; whether it is gitignored is not checked |
| `rel-path.ts:42, 46` | `.git` file of a submodule and its `commondir` | no: written by git, not by a merged tree; low |
| `deps.ts:162` | any source file under the root (`join(root, path)`); `exists` uses `statSync().isFile()` but the read does not | NO, and a real gap: a merged symlink to a FIFO named as a source file can hang `dependencyGraph`. Propose a new task |
| `cli/index.ts:362` | `<root>/.gitattributes` in `installMergeDriver` | no here; a merged file, same class as `deps.ts`; propose with it |
| `cli/index.ts:425, 694, 814, 1500` | settings file, merge-driver temp paths, a `--file` argument | no: a path the user or git passes, not named by a merged tree |

I read the last four rows from the code only. I did not run them.

### The change

1. `readJson` returns `fallback` unless `statSync(path).isFile()` is true (any stat error also gives `fallback`),
   so it never opens a FIFO, a device or a folder. A symlink to a regular file is still followed, as before.
   `regularFileIn(root, rel)` would also forbid links out of the root, but `readJson` takes an absolute path and has
   no `root`; the builder may add a `root` argument if the architect wants the stricter rule, and states the choice
   in the pull request.
2. `readSidecar`: `readBundle` first; else read the legacy `roadmap.json` only when
   `isLegacyStore(findProject(root)?.storeDir ?? BUNDLE_FILE)` is true; else `emptyRoadmap()`.
3. `writeSidecar`: when `mutateBundle` gives null and the project is not a legacy store, throw
   `No .project at <root>` instead of `writeJson`. A legacy store still writes `roadmap.json`.
4. `readCockpit` still throws `No .project` from `readProject` when `.project` is a folder (`store.ts:610-614`),
   after `readRoadmap` returns. That is existing and fine; the bug is only the hang. The regression test therefore
   probes `readRoadmap`, not `readCockpit`.

### Must not break

- A project with `.claude/project-companion/` (any `STORE_DIRS` name): reads and writes of `project.json`,
  `tasks.json`, `roadmap.json`, diagrams and boards, and `migrate` to `.project`. Control test 6 covers read and
  write of tasks, a diagram and `roadmap.json`; `migrate` is not covered by the new test (cover is the existing
  `tests/bundle.test.ts`; not checked).
- A normal `.project` file: `readSidecar` and `writeSidecar` use the bundle as now (control test 7).
- A missing file or bad JSON still gives `fallback`.

### Size

About 40 to 60 changed lines in `lib/project/` (basis: `readJson` +4 lines; `readSidecar` +4; `writeSidecar` +5;
one import; comments), plus the threat-model edit. This is an estimate, not a measurement. The test file is about
240 lines and is already written. Proposed split: the `deps.ts` and `.gitattributes` reads go in a new task.

### Threat-model text to change (rule 12, same change)

`specs/decision-alerts/threat-model.md`:
- TH-7 text, "Open:" list: remove "the `.project` folder fallback (task 49c078ce)".
- TH-7 residual 3, "Open, low" first bullet (the `readSidecar`/`writeSidecar` one, card c-4936f7): remove; add a
  "Fixed by bugfix 49c078ce" bullet for the `readJson` kind check and the `isLegacyStore` gate. List the `deps.ts`
  and `.gitattributes` reads as a new open residual, if the PM opens that task.
- D2 row, mitigation cell: delete "The roadmap read then falls back to `.project/roadmap.json` through `readJson`,
  with no check on its kind (`roadmap.ts:74-86`; task 49c078ce; see TH-7, residual 3)." Say that a `.project` that is
  not a regular file gives an empty roadmap on a read and a "No .project" error on a write.
- F2 row: "the rest is open in tasks 49c078ce, d78ae4cf and ce914d26" becomes "d78ae4cf and ce914d26".
- The older-layout files (`project.json`, `tasks.json`, diagrams, boards) have no row in the model today. The
  architect decides whether they need one.

## Regression test

`tests/bug-49c078ce.test.ts`, 7 tests. Hang cases run in a child process (this file with a flag) with a 3-second
kill timeout and a FIFO with no writer (not `/dev/zero`). Each test uses a temporary project and a temporary HOME,
no `CLAUDE_PROJECT_DIR`, and inherits `PROJECT_COMPANION_NOTIFY`.

1. `.project` as a folder with `roadmap.json` a symlink to a FIFO: `readRoadmap` must return and report no roadmap.
2. A legacy `tasks.json` that is a symlink to a FIFO: `readTasks` returns an empty list.
3. A legacy `diagrams/d1.json` that is a symlink to a FIFO: `readDiagram` returns null.
4. `.project` a symlink to a folder outside the root: `setPrdSource` does not create `roadmap.json` outside.
5. `.project` a real folder: `setPrdSource` does not create `.project/roadmap.json`.
6. Control: a normal legacy store still reads tasks, a diagram and `roadmap.json`, and writes `roadmap.json`.
7. Control: a normal `.project` file still reads and writes the PRD source.

Run on head `469df0c` (before the fix), `npm test -- bug-49c078ce`: 2 of 7 pass (the two controls), 5 fail.

```
  FAIL 49c078ce: .project as a folder with roadmap.json a symlink to a FIFO is read as no roadmap
       readRoadmap (the first call of readCockpit) must not block on .project/roadmap.json: expected false, got true
  FAIL 49c078ce: a legacy tasks.json that is a symlink to a FIFO is not read
       readTasks must not block on a tasks.json that is a FIFO: expected false, got true
  FAIL 49c078ce: a legacy diagram file that is a symlink to a FIFO is not read
       readDiagram must not block on a diagram file that is a FIFO: expected false, got true
  FAIL 49c078ce: a .project that is a symlink to a folder outside the root is not written through
       roadmap.json was written outside the root through the linked .project: expected false, got true
  FAIL 49c078ce: a .project that is a real folder gets no roadmap.json written into it
       the legacy fallback wrote into a .project folder: expected false, got true
2/7 passed
```

Run time: about 10 s wall clock for the whole command, including the dist build (each of the three hang cases waits
the 3-second kill timeout). Exit code: 1.
