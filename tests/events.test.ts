import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actorId, appendEvent, logDir, readEvents, readShard, resolveActor,
  verifyLog, verifyShard, type ActorIdentity,
} from "@/lib/project/events";
import { eq, ok, runAll, test } from "./harness";

/**
 * A real repository, because the actor identity is read out of git config and
 * mocking that would test the mock.
 */
const repo = (identity?: { name: string; email: string }) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pc-events-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();

  git("init", "-q", "-b", "main");
  git("config", "user.email", identity?.email ?? "dev@example.com");
  git("config", "user.name", identity?.name ?? "A Dev");
  git("config", "commit.gpgsign", "false");

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A fixed actor, so ordering assertions do not depend on the test machine. */
const as = (id: string, email = `${id}@example.com`): ActorIdentity => ({
  id, email, name: id, host: "test-host",
});

test("the actor id is stable, anonymous, and derived from identity plus host", () => {
  const a = actorId({ email: "dev@example.com", host: "laptop" });
  const b = actorId({ email: "dev@example.com", host: "laptop" });
  const c = actorId({ email: "dev@example.com", host: "desktop" });

  eq(a, b, "same identity gives the same id");
  ok(a !== c, "the same person on another machine gets another shard");
  ok(!a.includes("dev"), "the email does not survive into the id");
  eq(a.length, 12);
});

test("the actor is read from git config, not the OS user", () => {
  const { dir, cleanup } = repo({ name: "Grace H", email: "grace@example.com" });
  try {
    const actor = resolveActor(dir);
    eq(actor.email, "grace@example.com");
    eq(actor.name, "Grace H");
  } finally { cleanup(); }
});

test("`email` under another section is not mistaken for the user's", () => {
  const { dir, cleanup } = repo({ name: "Grace H", email: "grace@example.com" });
  try {
    // A real config where [sendemail] also carries an `email` key.
    writeFileSync(
      join(dir, ".git", "config"),
      [
        "[sendemail]",
        "\temail = list@lists.example.com",
        "[user]",
        "\temail = grace@example.com",
        "\tname = Grace H",
      ].join("\n"),
      "utf8",
    );
    eq(resolveActor(dir).email, "grace@example.com");
  } finally { cleanup(); }
});

test("a shard opens by stating who owns it", () => {
  const { dir, cleanup } = repo();
  try {
    const actor = as("alice");
    appendEvent(dir, { kind: "task.created", data: { id: "t1" } }, actor);

    const shard = readShard(dir, "alice");
    eq(shard.length, 2, "the identity event, then the task");
    eq(shard[0].kind, "actor.identified");
    eq(shard[0].seq, 0);
    eq(shard[0].prev, null);
    eq(shard[0].data.email, "alice@example.com");
    eq(shard[1].kind, "task.created");
    eq(shard[1].seq, 1);
  } finally { cleanup(); }
});

test("two actors never write the same file", () => {
  const { dir, cleanup } = repo();
  try {
    appendEvent(dir, { kind: "task.created", data: { id: "t1" } }, as("alice"));
    appendEvent(dir, { kind: "task.created", data: { id: "t2" } }, as("bob"));

    eq(readShard(dir, "alice").filter((e) => e.kind === "task.created").length, 1);
    eq(readShard(dir, "bob").filter((e) => e.kind === "task.created").length, 1);

    // Which is the whole point: a merge of these two shards has nothing to
    // resolve, because neither file was touched by both writers.
    const alice = readFileSync(join(logDir(dir), "alice.jsonl"), "utf8");
    ok(!alice.includes("t2"), "bob's events are not in alice's shard");
  } finally { cleanup(); }
});

test("the log reads back in one deterministic order across shards", () => {
  const { dir, cleanup } = repo();
  try {
    appendEvent(dir, { kind: "task.created", data: { n: 1 } }, as("alice"));
    appendEvent(dir, { kind: "task.created", data: { n: 2 } }, as("bob"));
    appendEvent(dir, { kind: "task.moved", data: { n: 3 } }, as("alice"));
    appendEvent(dir, { kind: "task.moved", data: { n: 4 } }, as("bob"));

    const order = readEvents(dir)
      .filter((e) => e.kind !== "actor.identified")
      .map((e) => e.data.n);
    eq(order, [1, 2, 3, 4], "writes come back in the order they happened");

    // And the same order, every time, from the same bytes.
    eq(readEvents(dir).map((e) => e.id), readEvents(dir).map((e) => e.id));
  } finally { cleanup(); }
});

test("the clock never runs backwards, even against another actor's shard", () => {
  const { dir, cleanup } = repo();
  try {
    const first = appendEvent(dir, { kind: "task.created", data: {} }, as("alice"));
    const second = appendEvent(dir, { kind: "task.created", data: {} }, as("bob"));
    const third = appendEvent(dir, { kind: "task.moved", data: {} }, as("alice"));

    ok(second.ts > first.ts, "bob sorts after alice's existing work");
    ok(third.ts > second.ts, "alice, writing again, sorts after bob");
  } finally { cleanup(); }
});

test("`since` returns only what is new", () => {
  const { dir, cleanup } = repo();
  try {
    const first = appendEvent(dir, { kind: "task.created", data: { n: 1 } }, as("alice"));
    appendEvent(dir, { kind: "task.moved", data: { n: 2 } }, as("alice"));

    const fresh = readEvents(dir, first.ts);
    eq(fresh.map((e) => e.data.n), [2]);
  } finally { cleanup(); }
});

test("a component id rides along when the event is about one", () => {
  const { dir, cleanup } = repo();
  try {
    appendEvent(dir, { kind: "task.created", componentId: "auth", data: {} }, as("alice"));
    appendEvent(dir, { kind: "task.created", data: {} }, as("alice"));

    const [scoped, unscoped] = readShard(dir, "alice").filter((e) => e.kind === "task.created");
    eq(scoped.componentId, "auth");
    eq(unscoped.componentId, undefined, "absent rather than empty when unscoped");
  } finally { cleanup(); }
});

test("an intact chain verifies", () => {
  const { dir, cleanup } = repo();
  try {
    for (let i = 0; i < 5; i++) {
      appendEvent(dir, { kind: "task.moved", data: { i } }, as("alice"));
    }
    eq(verifyShard(dir, "alice"), []);
    eq(verifyLog(dir), []);
  } finally { cleanup(); }
});

test("editing a record after the fact breaks the chain and says where", () => {
  const { dir, cleanup } = repo();
  try {
    for (let i = 0; i < 5; i++) {
      appendEvent(dir, { kind: "task.moved", data: { i } }, as("alice"));
    }

    const path = join(logDir(dir), "alice.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // Quietly rewrite the third record, as somebody covering their tracks would.
    lines[2] = lines[2].replace('"i":1', '"i":99');
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const breaks = verifyShard(dir, "alice");
    ok(breaks.length > 0, "the tampering is detected");
    eq(breaks[0].reason, "prev-mismatch");
    eq(breaks[0].seq, 3, "the break is reported at the record after the edit");
  } finally { cleanup(); }
});

test("removing a record is detected too", () => {
  const { dir, cleanup } = repo();
  try {
    for (let i = 0; i < 4; i++) {
      appendEvent(dir, { kind: "task.moved", data: { i } }, as("alice"));
    }

    const path = join(logDir(dir), "alice.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines.splice(2, 1);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const reasons = verifyShard(dir, "alice").map((b) => b.reason);
    ok(reasons.includes("seq-gap"), "the missing sequence number shows up");
  } finally { cleanup(); }
});

test("one corrupt line does not cost the rest of the history", () => {
  const { dir, cleanup } = repo();
  try {
    appendEvent(dir, { kind: "task.created", data: { n: 1 } }, as("alice"));
    appendEvent(dir, { kind: "task.moved", data: { n: 2 } }, as("alice"));

    const path = join(logDir(dir), "alice.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // A half-written line, of the kind a crash or a bad merge leaves behind.
    lines.splice(1, 0, '{"id":"alice:9","ts":1,"kind":');
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const kept = readShard(dir, "alice").map((e) => e.data.n);
    eq(kept, [undefined, 1, 2], "the identity event and both real events survive");
  } finally { cleanup(); }
});

test("an unknown event kind is preserved, not dropped", () => {
  const { dir, cleanup } = repo();
  try {
    appendEvent(dir, { kind: "task.created", data: {} }, as("alice"));

    // What a newer build writes, read by an older one.
    const path = join(logDir(dir), "alice.jsonl");
    const previous = readShard(dir, "alice").at(-1)!;
    const future = {
      id: "alice:2", ts: previous.ts + 1, seq: 2, actor: "alice",
      prev: null, kind: "something.newer", data: { fine: true },
    };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(future)}\n`, "utf8");

    const kinds = readShard(dir, "alice").map((e) => e.kind);
    ok(kinds.includes("something.newer" as never), "a kind we do not know is still read");
  } finally { cleanup(); }
});

test("reading a project with no log at all is empty, not an error", () => {
  const { dir, cleanup } = repo();
  try {
    eq(readEvents(dir), []);
    eq(verifyLog(dir), []);
    eq(readShard(dir, "nobody"), []);
  } finally { cleanup(); }
});

runAll().then((failed) => process.exit(failed ? 1 : 0));
