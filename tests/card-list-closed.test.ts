/**
 * Quick spec f0770230: `card list --json` adds a computed boolean `closed` to
 * each card (CL-01.1 to CL-01.7). It is worked out at print time by
 * `isCardClosed`; it is never stored in the log, `Card` or `foldCards`.
 *
 * Spawns the built CLI (`npm run build:tools` first, as for the ee2e49d6 suite).
 * Notifications stay off, HOME is a temp folder, CLAUDE_PROJECT_DIR is dropped
 * (test rules 1, 2, 5), and every call has a 10 s timeout (rule 3).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { foldCards, isCardClosed } from "@/lib/project/decisions";
import { readEvents } from "@/lib/project/events";
import { foldGates } from "@/lib/project/gate";
import { initProject } from "@/lib/project/store";
import { eq, ok, runAll, test } from "./harness";

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("card-list-closed.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- card-list-closed\n");
  process.exit(1);
}

const execFileP = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-f0770230-")));
const HOME = join(TMP, "home");
mkdirSync(HOME);
const { CLAUDE_PROJECT_DIR: _dir, ...BASE_ENV } = process.env;

const pc = (dir: string, ...args: string[]) =>
  execFileP(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...BASE_ENV, PROJECT_COMPANION_NOTIFY: "off", HOME },
    timeout: 10_000,
  }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code?: number; stdout?: string; stderr?: string }) => ({
    code: e.code ?? -1,
    out: e.stdout ?? "",
    err: e.stderr ?? "",
  }));

const project = (): string => {
  const root = mkdtempSync(join(TMP, "p-"));
  initProject(root, "Demo");
  return root;
};

type Printed = Record<string, unknown> & { id: string; closed: unknown };

const open = async (root: string, subject: string, ask: string, kind: "question" | "track" = "question"): Promise<string> => {
  const r = await pc(root, "card", "open", "--subject", subject, "--ask", ask, "--kind", kind, "--json");
  eq(r.code, 0, r.err);
  return (JSON.parse(r.out) as { id: string }).id;
};
const list = async (root: string, ...flags: string[]): Promise<Printed[]> => {
  const r = await pc(root, "card", "list", ...flags, "--json");
  eq(r.code, 0, r.err);
  return JSON.parse(r.out) as Printed[];
};
const byId = (cards: Printed[], id: string): Printed => cards.find((c) => c.id === id) ?? ({ id, closed: "missing" } as Printed);
const confirm = async (root: string, subject: string) => {
  const r = await pc(root, "gate", "track", subject, "full", "--via", "prompt:pm");
  eq(r.code, 0, r.err);
};
const answer = async (root: string, id: string) => {
  const r = await pc(root, "card", "answer", id, "ses", "--via", "prompt:pm");
  eq(r.code, 0, r.err);
};

test("CL-01.1: closed matches isCardClosed for every card", async () => {
  const root = project();
  const q = await open(root, "auth", "Which provider?");
  const t = await open(root, "alerts", "Which track?", "track");
  await answer(root, q);
  await confirm(root, "alerts");
  await open(root, "alerts", "Which track now?", "track");
  const events = readEvents(root);
  const cards = foldCards(events);
  const tracks = foldGates(events).tracks;
  const printed = await list(root);
  eq(printed.length, 3);
  for (const c of printed) {
    eq(typeof c.closed, "boolean");
    eq(c.closed, isCardClosed(cards.get(c.id)!, tracks), `card ${c.id}`);
  }
  ok(byId(printed, q).closed === true && byId(printed, t).closed === true, "answered and confirmed cards are closed");
});

test("CL-01.2: a confirmed track card prints closed true with no answer key", async () => {
  const root = project();
  const id = await open(root, "alerts", "Which track?", "track");
  await confirm(root, "alerts");
  const c = byId(await list(root), id);
  eq(c.closed, true);
  eq("answer" in c, false);
});

test("CL-01.3: unanswered cards print closed false", async () => {
  const root = project();
  const fresh = await open(root, "auth", "Which provider?");
  const q = await open(root, "alerts", "Which email provider?");
  await confirm(root, "alerts");
  const later = await open(root, "alerts", "Which track now?", "track");
  const printed = await list(root);
  eq(byId(printed, fresh).closed, false);
  eq(byId(printed, q).closed, false);
  eq(byId(printed, later).closed, false);
});

test("CL-01.4: existing fields keep name, value and order; closed is last", async () => {
  const root = project();
  const q = await open(root, "auth", "Which provider?");
  await open(root, "alerts", "Which track?", "track");
  await answer(root, q);
  await confirm(root, "alerts");
  await open(root, "alerts", "Again?", "track");
  const folded = foldCards(readEvents(root));
  const all = Array.from(folded.values());
  const tracks = foldGates(readEvents(root)).tracks;
  for (const flags of [[], ["--open"]]) {
    const printed = await list(root, ...flags);
    const want = all.filter((c) => !flags.length || !isCardClosed(c, tracks)).map((c) => c.id);
    eq(printed.map((c) => c.id), want, `same cards, same order ${flags.join(" ")}`);
    for (const c of printed) {
      eq(Object.keys(c).at(-1), "closed");
      const { closed: _closed, ...rest } = c;
      eq(rest, JSON.parse(JSON.stringify(folded.get(c.id))), `card ${c.id}`); // eq compares key order too
    }
  }
});

test("CL-01.5: --open --json holds only closed false cards", async () => {
  const root = project();
  const q = await open(root, "auth", "Which provider?");
  await open(root, "alerts", "Which track?", "track");
  await answer(root, q);
  await open(root, "ci", "Which runner?");
  await confirm(root, "alerts");
  await open(root, "alerts", "Again?", "track");
  const json = await list(root, "--open");
  eq(json.length, 2);
  ok(json.every((c) => c.closed === false), "every kept card says false");
  const text = (await pc(root, "card", "list", "--open")).out;
  eq(json.map((c) => c.id), text.trim().split("\n").map((l) => l.split("  ")[0]));
});

test("CL-01.6: text output is unchanged", async () => {
  const root = project();
  eq((await pc(root, "card", "list")).out, "No cards.\n");
  eq((await pc(root, "card", "list", "--open")).out, "No cards.\n");
  const a = await open(root, "auth", "Which provider?");
  const t = await open(root, "alerts", "Which track?", "track");
  await confirm(root, "alerts");
  eq((await pc(root, "card", "list")).out, `${a}  open      auth             Which provider?\n${t}  answered  alerts           Which track?\n`);
  eq((await pc(root, "card", "list", "--open")).out, `${a}  open      auth             Which provider?\n`);
});

const digest = (path: string): string => {
  const h = createHash("sha256");
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p).sort()) {
        h.update(n);
        walk(join(p, n));
      }
    } else h.update(readFileSync(p));
  };
  walk(path);
  return h.digest("hex");
};
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = { ".project": digest(join(root, ".project")) };
  const dir = join(root, ".project-log");
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) out[n] = digest(join(dir, n));
  return out;
};

test("CL-01.7: card list writes nothing", async () => {
  const root = project();
  await open(root, "alerts", "Which track?", "track");
  await confirm(root, "alerts");
  await open(root, "auth", "Which provider?");
  const before = snapshot(root);
  for (const flags of [[], ["--open"], ["--json"], ["--open", "--json"]]) {
    const r = await pc(root, "card", "list", ...flags);
    eq(r.code, 0, r.err);
  }
  eq(snapshot(root), before);
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
