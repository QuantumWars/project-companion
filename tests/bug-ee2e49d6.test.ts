/**
 * Regression test for bug ee2e49d6: a confirmed track card never leaves the
 * PM's open list.
 *
 * `project-companion card open --kind track` opens a decision card. The PM
 * confirms a track with `gate track <subject> <full|quick|bugfix> --via
 * <channel>`, which appends a `track.confirmed` event (`confirmTrack` in
 * `lib/project/gate.ts`). That event never carries a `cardId`, so `foldCards`
 * (`lib/project/decisions.ts`) -- which only reacts to `card.opened` and
 * `card.answered` -- never sets `answer` on the track card. `card list
 * --open` (`cli/index.ts`, the `command === "card"` branch) filters on
 * `c.answer === undefined` alone, so a confirmed track card is still "open"
 * forever.
 *
 * `lib/project/cockpit.ts` already carries the fix for its own "needs you"
 * list: `buildCockpit` drops a track card once `gates.tracks.get(c.subject)`
 * is newer than the card (line ~174), and `tests/devolps-phase3.test.ts`
 * ("needs you: a track card closes when the track is confirmed") already
 * proves it. This suite only proves the CLI's `card list --open`, which has
 * no such check, still disagrees with the cockpit on the same event log.
 *
 * This suite spawns the built CLI, so it must never show a real notification
 * (`card open` sends one, DA-01.2): it refuses to run unless
 * PROJECT_COMPANION_NOTIFY is already "off" (set by the test runner), it
 * never writes to process.env itself, and every spawned CLI call also gets
 * an explicit PROJECT_COMPANION_NOTIFY=off and a HOME inside this suite's own
 * temporary folder, never the real one.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isCardClosed, type Card } from "@/lib/project/decisions";
import { initProject } from "@/lib/project/store";
import { eq, ok, runAll, test } from "./harness";

if (process.env.PROJECT_COMPANION_NOTIFY !== "off") {
  process.stderr.write("bug-ee2e49d6.test.ts: PROJECT_COMPANION_NOTIFY is not off; run this suite with npm test -- bug-ee2e49d6\n");
  process.exit(1);
}

const execFileP = promisify(execFile);
const CLI = join(process.cwd(), "dist", "project-companion.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "pc-ee2e49d6-")));
const HOME = join(TMP, "home"); // never the real ~/.claude (security F1)
mkdirSync(HOME);
// CLAUDE_PROJECT_DIR is dropped: the CLI would find its project there before the cwd (test rule 5).
const { CLAUDE_PROJECT_DIR: _dir, ...BASE_ENV } = process.env;

/** Runs the CLI in `root`, notifications explicitly off, HOME in this suite's own temp folder. */
const pc = (dir: string, ...args: string[]) =>
  execFileP(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...BASE_ENV, PROJECT_COMPANION_NOTIFY: "off", HOME },
    timeout: 10_000, // a failure is an assertion, not a stuck suite (test rule 3)
  }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code?: number; stdout?: string; stderr?: string }) => ({
    code: e.code ?? -1,
    out: e.stdout ?? "",
    err: e.stderr ?? "",
  }));

/** A bare project in its own temp folder, never the real .project of this repository. */
const project = (): string => {
  const root = mkdtempSync(join(TMP, "p-"));
  initProject(root, "Demo");
  return root;
};

const cardId = (out: string): string => (JSON.parse(out) as { id: string }).id;

test("ee2e49d6: card list --open still shows a track card after its track is confirmed", async () => {
  const root = project();
  const opened = await pc(root, "card", "open", "--subject", "alerts", "--ask", "Which track?", "--kind", "track", "--json");
  eq(opened.code, 0, opened.err);
  const id = cardId(opened.out);

  const confirmed = await pc(root, "gate", "track", "alerts", "full", "--via", "prompt:pm");
  eq(confirmed.code, 0, confirmed.err);

  const list = await pc(root, "card", "list", "--open", "--json");
  eq(list.code, 0, list.err);
  const ids = (JSON.parse(list.out) as { id: string }[]).map((c) => c.id);

  // The PM confirmed the track; the card must not stay on the open list.
  eq(ids.includes(id), false, "a confirmed track card must leave card list --open");
});

test("ee2e49d6: the cockpit's needs-you list already drops the same card (control)", async () => {
  const root = project();
  const opened = await pc(root, "card", "open", "--subject", "ci", "--ask", "Which track?", "--kind", "track", "--json");
  const id = cardId(opened.out);
  await pc(root, "gate", "track", "ci", "quick", "--via", "prompt:pm");

  const model = JSON.parse((await pc(root, "cockpit", "--json")).out) as { needsYou: { id: string }[] };
  ok(!model.needsYou.some((d) => d.id === id), "the cockpit already excludes a confirmed track card");
});

const openIds = async (root: string): Promise<string[]> =>
  (JSON.parse((await pc(root, "card", "list", "--open", "--json")).out) as { id: string }[]).map((c) => c.id);

test("ee2e49d6: a track card opened again after the confirmation stays open", async () => {
  const root = project();
  const first = await pc(root, "card", "open", "--subject", "alerts", "--ask", "Which track?", "--kind", "track", "--json");
  eq(first.code, 0, first.err);
  const confirmed = await pc(root, "gate", "track", "alerts", "full", "--via", "prompt:pm");
  eq(confirmed.code, 0, confirmed.err);
  const second = await pc(root, "card", "open", "--subject", "alerts", "--ask", "Which track now?", "--kind", "track", "--json");
  eq(second.code, 0, second.err);
  const ids = await openIds(root);
  ok(!ids.includes(cardId(first.out)), "the first card closed when the track was confirmed");
  ok(ids.includes(cardId(second.out)), "a card opened after the confirmation stays open");
});

test("ee2e49d6: a question card is not closed by a track confirmation; plain text says answered for a closed track card", async () => {
  const root = project();
  const q = cardId((await pc(root, "card", "open", "--subject", "alerts", "--ask", "Which email provider?", "--json")).out);
  const t = cardId((await pc(root, "card", "open", "--subject", "alerts", "--ask", "Which track?", "--kind", "track", "--json")).out);
  await pc(root, "gate", "track", "alerts", "full", "--via", "prompt:pm");
  const ids = await openIds(root);
  ok(ids.includes(q) && !ids.includes(t), "only the question card stays open");
  const text = (await pc(root, "card", "list")).out;
  ok(new RegExp(`${t}  answered`).test(text), "plain text shows the closed track card as answered");
  ok(new RegExp(`${q}  open`).test(text), "plain text shows the question card as open");
});

/* isCardClosed edge cases, in process (L4). */
const mk = (over: Partial<Card>): Card => ({ id: "c-x", kind: "track", subject: "s", ask: "?", options: [], openedAt: 100, ...over });
const tr = (...ats: number[]) => {
  const m = new Map<string, { at: number }>();
  for (const at of ats) m.set("s", { at }); // the later event replaces the earlier, as foldGates does
  return m;
};

test("ee2e49d6: isCardClosed: a confirmation at the card's own timestamp leaves it open", () => {
  eq(isCardClosed(mk({}), tr(100)), false);
  eq(isCardClosed(mk({}), tr(101)), true);
});

test("ee2e49d6: isCardClosed: the later of two confirmations decides", () => {
  eq(isCardClosed(mk({ openedAt: 150 }), tr(200, 120)), false, "latest is older than the card");
  eq(isCardClosed(mk({ openedAt: 150 }), tr(120, 200)), true, "latest is newer than the card");
});

test("ee2e49d6: isCardClosed: a track card with no confirmed track stays open", () => {
  eq(isCardClosed(mk({}), new Map()), false);
  eq(isCardClosed(mk({ subject: "other" }), tr(500)), false, "another subject's track does not count");
});

test("ee2e49d6: isCardClosed: a question card is never closed by a track", () => {
  eq(isCardClosed(mk({ kind: "question" }), tr(500)), false);
});

test("ee2e49d6: isCardClosed: a card with an answer is closed", () => {
  eq(isCardClosed(mk({ kind: "question", answer: "yes" }), new Map()), true);
  eq(isCardClosed(mk({ answer: "full" }), new Map()), true);
});

runAll().then((failed) => {
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
