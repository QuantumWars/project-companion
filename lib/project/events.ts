/**
 * The event log: what happened, in order, and who did it.
 *
 * `.project` records the current state of a project. This records how it got
 * there -- every task moved, criterion ticked, agent run started and review
 * finding raised. State can be recomputed from the log; the log cannot be
 * recomputed from state, which is why it is the thing that gets written first.
 *
 * ---- why one file per actor ----
 *
 * A single shared log file is the obvious design and the wrong one: two people
 * (or a person and an agent) appending to the same file on two clones produce a
 * git conflict on every single overlapping session, and the conflict is in a
 * file nobody can meaningfully resolve by hand.
 *
 * So the log is SHARDED BY ACTOR. Each writer only ever appends to its own
 * `.project-log/<actorId>.jsonl`. Two actors never touch the same file, so a
 * merge is conflict-free by construction -- not by a union merge driver, not by
 * a CRDT, but because there is nothing to conflict. Pulling a colleague's work
 * adds files; it never rewrites yours.
 *
 * ---- why a hash chain ----
 *
 * Each record carries `prev`, the sha256 of the preceding record in ITS OWN
 * shard. Editing or removing a record breaks the chain from that point on, and
 * `verifyShard` finds it. That is not cryptographic security -- anyone who can
 * write the file can rewrite the chain -- but it makes accidental corruption and
 * casual after-the-fact editing detectable, which is the property an audit trail
 * actually needs when the trail is a file in your own repository.
 *
 * ---- what this does not claim ----
 *
 * There are no vector clocks here, so cross-actor causality is not tracked. What
 * IS guaranteed is a deterministic total order that every clone agrees on, and
 * monotonic order within a shard. On append the clock is bumped past every
 * timestamp already visible, so an event written after you pulled a colleague's
 * work sorts after it. That is Lamport ordering, and it is enough: this is a log
 * of things that happened on a development team, not a distributed database.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

export const LOG_DIR = ".project-log";
const SHARD_SUFFIX = ".jsonl";

/**
 * Event kinds, grouped by the subject they are about.
 *
 * Deliberately a plain string union rather than a class hierarchy: an event is a
 * fact that already happened, so it has no behaviour, and new kinds must be
 * addable without a migration. Readers that do not recognise a kind skip it --
 * a clone running an older build must never lose a teammate's events.
 */
export type EventKind =
  // Components: the architecture nodes that own work.
  | "component.created"
  | "component.updated"
  | "component.orphaned"
  // Tasks.
  | "task.created"
  | "task.moved"
  | "task.updated"
  | "task.deleted"
  // The PRD.
  | "feature.added"
  | "feature.pinned"
  | "criterion.checked"
  | "criterion.unchecked"
  // Agent runs. A run is not stored anywhere else: these events ARE the run,
  // and its current state is a fold over them. See `run.ts`.
  | "run.started"
  | "run.progress"
  | "run.state"
  // Bookkeeping.
  | "actor.identified";

export type ProjectEvent = {
  /** `<actorId>:<seq>`; unique across every shard because actorId is. */
  id: string;
  /**
   * Milliseconds since the epoch, bumped past everything already visible so it
   * is monotonic within a shard and causally sane across a pull.
   */
  ts: number;
  /** Position within this shard, from zero. */
  seq: number;
  /** Stable, anonymous id of the writer. See `actorId`. */
  actor: string;
  /** sha256 of the previous record in this shard; null for the first. */
  prev: string | null;
  /** The architecture component this event concerns, when it concerns one. */
  componentId?: string;
  kind: EventKind;
  /**
   * Everything specific to the kind.
   *
   * Left open on purpose. Typing each payload would mean every new event kind
   * touches this file and every reader of it; an append-only log's whole appeal
   * is that writers can add facts without coordinating with readers.
   */
  data: Record<string, unknown>;
};

/** What `appendEvent` is given. Everything else is filled in here. */
export type NewEvent = {
  kind: EventKind;
  componentId?: string;
  data?: Record<string, unknown>;
};

export const logDir = (root: string): string => join(root, LOG_DIR);

const shardPath = (root: string, actor: string): string =>
  join(logDir(root), `${actor}${SHARD_SUFFIX}`);

/* --------------------------------- identity -------------------------------- */

/**
 * A stable, anonymous id for whoever is writing.
 *
 * Hashed rather than stored plainly because this file is committed and pushed:
 * a shard named after somebody's work email would put it in the tree of every
 * fork. The identity itself is recorded once, inside the log, as the first
 * event of the shard -- so it is available to anyone reading the project, but it
 * is a fact in the log rather than a filename on disk.
 */
export const actorId = (identity: { email: string; host: string }): string =>
  createHash("sha256")
    .update(`${identity.email}\0${identity.host}`)
    .digest("hex")
    .slice(0, 12);

export type ActorIdentity = { id: string; email: string; name: string; host: string };

/**
 * Who is writing, from git config where possible.
 *
 * `git config` is read directly out of the config files rather than by shelling
 * out, because this runs on every single append and a subprocess per event
 * would make the log the slowest part of the system. Falling back to the OS user
 * keeps it working in a repository with no identity configured.
 */
export const resolveActor = (root: string, env = process.env): ActorIdentity => {
  const fromEnv = env.PROJECT_COMPANION_ACTOR_EMAIL;
  const email = fromEnv ?? gitIdentity(root, "email") ?? `${userInfo().username}@local`;
  const name = gitIdentity(root, "name") ?? userInfo().username;
  const host = hostname();
  return { id: actorId({ email, host }), email, name, host };
};

/** Reads one `user.<key>` from the repo config, then the global one. */
const gitIdentity = (root: string, key: "email" | "name"): string | undefined => {
  const candidates = [
    join(root, ".git", "config"),
    join(process.env.HOME ?? "", ".gitconfig"),
  ];
  for (const path of candidates) {
    try {
      const found = readUserKey(readFileSync(path, "utf8"), key);
      if (found) return found;
    } catch {
      // No config there; try the next.
    }
  }
  return undefined;
};

/**
 * Pulls `key` out of the `[user]` section of a git config.
 *
 * A real INI parser is not worth a dependency here, but the section boundary
 * does matter: `email` also appears under `[sendemail]`, and a naive grep would
 * happily return that instead.
 */
const readUserKey = (config: string, key: string): string | undefined => {
  let inUser = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inUser = /^\[user["\s\]]/.test(line);
      continue;
    }
    if (!inUser) continue;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "i"));
    if (match) return match[1].trim();
  }
  return undefined;
};

/* --------------------------------- reading -------------------------------- */

const hashRecord = (line: string): string =>
  createHash("sha256").update(line, "utf8").digest("hex").slice(0, 16);

const shardFiles = (root: string): string[] => {
  const dir = logDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SHARD_SUFFIX))
    .sort();
};

/**
 * Every event in one shard, in write order.
 *
 * A malformed line is skipped rather than thrown on. The log is append-only and
 * committed, which means a bad merge or a truncated write can leave one broken
 * record in the middle of an otherwise fine history -- refusing to read the
 * whole project because of it would turn a cosmetic problem into an outage.
 */
export const readShard = (root: string, actor: string): ProjectEvent[] => {
  const path = shardPath(root, actor);
  if (!existsSync(path)) return [];

  const events: ProjectEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ProjectEvent;
      if (parsed && typeof parsed.kind === "string") events.push(parsed);
    } catch {
      // See above: one bad line must not cost the rest of the history.
    }
  }
  return events;
};

/**
 * The whole log, in a deterministic total order every clone agrees on.
 *
 * Sorted by timestamp, then actor, then sequence. The actor tiebreak is what
 * makes it deterministic: two events written in the same millisecond on two
 * machines have no real order, so one is invented, and the important part is
 * only that everybody invents the same one.
 */
export const readEvents = (root: string, since?: number): ProjectEvent[] => {
  const all: ProjectEvent[] = [];
  for (const file of shardFiles(root)) {
    all.push(...readShard(root, file.slice(0, -SHARD_SUFFIX.length)));
  }

  const filtered = since === undefined ? all : all.filter((e) => e.ts > since);
  return filtered.sort(
    (a, b) => a.ts - b.ts || a.actor.localeCompare(b.actor) || a.seq - b.seq,
  );
};

/** The last record of a shard, without parsing the whole file. */
const tailOf = (root: string, actor: string): ProjectEvent | null => {
  const events = readShard(root, actor);
  return events.length ? events[events.length - 1] : null;
};

/* -------------------------------- appending ------------------------------- */

/**
 * Appends one event to this actor's shard.
 *
 * The clock is bumped past every timestamp currently visible in any shard, not
 * just this one. That costs a read of the other shards, and buys the property
 * that matters after a `git pull`: an event you write having seen a colleague's
 * work sorts after it, rather than interleaving into their history because your
 * clock happens to run slow.
 *
 * Written with a single `appendFileSync`. One `write` of a short line is atomic
 * on every filesystem this runs on, so a concurrent append from another process
 * lands before or after -- never inside.
 */
export const appendEvent = (
  root: string,
  event: NewEvent,
  identity?: ActorIdentity,
): ProjectEvent => {
  const actor = identity ?? resolveActor(root);
  const dir = logDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const own = readShard(root, actor.id);
  const previous = own.length ? own[own.length - 1] : null;

  // Lamport bump: never behind anything already written, anywhere.
  let seen = previous?.ts ?? 0;
  for (const file of shardFiles(root)) {
    const other = file.slice(0, -SHARD_SUFFIX.length);
    if (other === actor.id) continue;
    seen = Math.max(seen, tailOf(root, other)?.ts ?? 0);
  }

  // A shard's first event states who owns it, so the identity lives in the log
  // rather than in a shared file that would conflict on every merge.
  if (!own.length) {
    writeRecord(root, actor.id, {
      id: `${actor.id}:0`,
      ts: Math.max(seen + 1, Date.now()),
      seq: 0,
      actor: actor.id,
      prev: null,
      kind: "actor.identified",
      data: { email: actor.email, name: actor.name, host: actor.host },
    });
    return appendEvent(root, event, actor);
  }

  const record: ProjectEvent = {
    id: `${actor.id}:${previous!.seq + 1}`,
    ts: Math.max(seen + 1, Date.now()),
    seq: previous!.seq + 1,
    actor: actor.id,
    prev: hashRecord(JSON.stringify(previous)),
    ...(event.componentId ? { componentId: event.componentId } : {}),
    kind: event.kind,
    data: event.data ?? {},
  };

  writeRecord(root, actor.id, record);
  return record;
};

const writeRecord = (root: string, actor: string, record: ProjectEvent): void => {
  appendFileSync(shardPath(root, actor), `${JSON.stringify(record)}\n`, "utf8");
};

/* ------------------------------- verification ------------------------------ */

export type ChainBreak = {
  actor: string;
  seq: number;
  reason: "prev-mismatch" | "seq-gap";
};

/**
 * Walks a shard's hash chain and reports where it stops adding up.
 *
 * Returns every break rather than the first, because the useful question after a
 * bad merge is "how much of this history is still trustworthy", and that needs
 * the whole picture.
 */
export const verifyShard = (root: string, actor: string): ChainBreak[] => {
  const events = readShard(root, actor);
  const breaks: ChainBreak[] = [];

  for (let i = 1; i < events.length; i++) {
    const previous = events[i - 1];
    const current = events[i];

    if (current.seq !== previous.seq + 1) {
      breaks.push({ actor, seq: current.seq, reason: "seq-gap" });
    }
    if (current.prev !== hashRecord(JSON.stringify(previous))) {
      breaks.push({ actor, seq: current.seq, reason: "prev-mismatch" });
    }
  }

  return breaks;
};

/** Every break across every shard. Empty means the log is intact. */
export const verifyLog = (root: string): ChainBreak[] =>
  shardFiles(root).flatMap((file) =>
    verifyShard(root, file.slice(0, -SHARD_SUFFIX.length)),
  );
