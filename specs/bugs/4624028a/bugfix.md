# Bug: one event line with a bad `ts` or `data` breaks every run read (4624028a)

## Observed

`readShard` (`lib/project/events.ts`, about lines 315-330) keeps a parsed line when `kind` is a string:

```ts
const parsed = JSON.parse(line) as ProjectEvent;
if (parsed && typeof parsed.kind === "string") events.push(parsed);
```

It does not check `ts` or `data`. Two kinds of bad line then reach `runsFrom` (`lib/project/run.ts`):

1. `ts` out of range or not a number (`1e20`, a string, null, missing). For any event with a `runId`,
   `new Date(event.ts).toISOString()` (about line 223) throws `RangeError: Invalid time value`. A null or missing
   `ts` does not throw in every case, but it sorts first (as 0), so the run's later events apply before its start
   and the run reads wrong (state `running` instead of `awaiting_review`).
2. `data` missing or not an object (null, a string, an array). `runsFrom` reads `data.to` and `data.runId`
   (about lines 213-218) with no check. `null` and missing `data` throw `TypeError`. A string or array does not
   throw, but the line is still not a valid record. Case 2 was already on master before job 002.

Result: one bad line in a committed shard makes the run list fail, or read wrong, for the whole project.

## Expected

The reader's own comment on `readShard`: "one bad line must not cost the rest of the history". A bad line is
skipped. Every good record in the same log is still read, and `runsFrom` returns the runs the good records
describe.

Requirement ID: none. I searched `docs/prd.md` and `specs/*/requirements.md` for the event log, malformed lines
and bad records, and found no criterion for it. The nearest sources are:

- the `readShard` code comment (above);
- test rule 11 in `docs/test-rules.md` (a reader ignores records whose `ts` is not a valid Date, with a test
  beside a good record; from the job 002 reviews, security S1);
- bug 54b4e811 / TH-7 residual 3 (`specs/decision-alerts/threat-model.md`), which changed the same function but
  is about the kind of file at the shard path, not about its lines.

The EM should decide whether to add a requirement ID for this. This spec cites the code comment and rule 11.

## Steps to reproduce

1. Make a project root with `.project-log/<actor>.jsonl` holding three lines: a good `run.started` for `run-1`,
   a bad line (for example `"ts":1e20` on a `run.progress`, or `"data":null` on a `task.moved`), and a good
   `run.state` that sets `run-1` to `awaiting_review`.
2. Call `runsFrom(readEvents(root))`.
3. It throws (`Invalid time value`, or `Cannot read properties of null (reading 'to')`), or returns `run-1` in
   state `running`.

Or run `npm test` and read the failures of `tests/bug-4624028a.test.ts`.

## Root cause

`readShard` checks only that `kind` is a string. The type `ProjectEvent` promises a finite `ts` and an object
`data`, but `JSON.parse(...) as ProjectEvent` is a cast, not a check. Each reader then has to defend itself,
and `runsFrom` does so only in part: it guards `ts` for the `task.moved` done time (`validTs`, about lines
215-216) but not for the `toISOString()` call below it, and it never guards `data`.

## Fix

In `readShard`, keep a line only when all of these hold:

- `kind` is a string (as now);
- `ts` is a finite number and `new Date(ts)` is a valid Date;
- `data` is a non-null object and not an array.

Do not change the return type or the other callers.

`runsFrom` keeps its own `validTs` guard (about lines 215-216). It is a second line of defence for callers that
pass events which did not come from `readShard`, and it costs nothing. It may stay. The reader fix does not
need it, and removing it is out of scope. Optionally, `runsFrom` may use `validTs` for the `toISOString()` call
too, but the regression test does not require it.

## Regression test

`tests/bug-4624028a.test.ts` (size: small; temporary folders, removed in `finally`). For each of 8 bad lines
(`ts` 1e20, string, null, missing; `data` null, string, array, missing) placed between a good `run.started` and
a good `run.state`, it has two tests:

- `4624028a: readShard drops a line with <case> and keeps the good lines` (reads `readShard`);
- `4624028a: runsFrom still reads the good run when the log holds a line with <case>` (reads
  `runsFrom(readEvents(root))` and expects `run-1` in state `awaiting_review`).

On the current code, all 16 fail (`npm test`: `0/16 passed` for this file). After the fix they must all pass.
