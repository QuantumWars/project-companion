/**
 * Three-way merge for `.project`.
 *
 * Git's default driver compares lines. `.project` is one JSON object whose keys
 * are independent -- a diagram, a component, a task -- so two people touching
 * different parts of the project produce a conflict in a file neither can
 * usefully resolve by hand. Merging it structurally makes that conflict
 * disappear, because it was never a real one.
 *
 * The rule is the same at every level: if only one side changed a thing, take
 * that side. If both changed it, take the one that says it was updated later.
 * Only when both changed a thing and neither carries a timestamp is there a
 * genuine conflict, and then the merge fails rather than picking a winner --
 * losing somebody's diagram silently is worse than making them merge it.
 *
 * The event log needs none of this: it is sharded one file per actor, so no two
 * writers touch the same file. This exists because the bundle is one file that
 * everybody writes, which is the thing worth knowing when deciding where to put
 * the next kind of state.
 */

export type MergeResult = { merged: unknown; conflicts: string[] };

const BOOKKEEPING = ["revision", "updatedAt"] as const;

const withoutBookkeeping = (value: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...value };
  for (const key of BOOKKEEPING) delete out[key];
  return out;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `updatedAt` where a value has one; the tiebreak when both sides changed. */
const stamp = (value: unknown): string =>
  isObject(value) && typeof value.updatedAt === "string" ? value.updatedAt : "";

/**
 * Arrays keyed by `id` are merged as maps, not as sequences.
 *
 * `tasks` is a list, but its order is presentation -- `order` carries the real
 * position -- so treating it positionally would make two people adding a task
 * at the same index into a conflict about a task neither of them touched.
 */
const keyed = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every((v) => isObject(v) && typeof v.id === "string");

const byId = (rows: Record<string, unknown>[]) =>
  Object.fromEntries(rows.map((r) => [r.id as string, r]));

const mergeValue = (
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string,
  conflicts: string[],
): unknown => {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;

  // Both sides moved. An object carrying `updatedAt` is an entity -- a
  // component, a diagram, a task -- and the whole of it is what somebody
  // edited, so the later version wins outright. Merging its fields would build
  // a third version neither person wrote: half of one rename and half of
  // another is not a compromise, it is a new mistake.
  const mine = stamp(ours);
  const yours = stamp(theirs);
  if (mine && yours) return mine >= yours ? ours : theirs;

  // No stamp to arbitrate with, so this is a container. Recurse, and let the
  // conflict be reported against the smallest thing that actually collided.
  if (isObject(ours) && isObject(theirs)) {
    return mergeObjects(isObject(base) ? base : {}, ours, theirs, path, conflicts);
  }
  if (keyed(ours) && keyed(theirs)) {
    const merged = mergeObjects(
      keyed(base) ? byId(base) : {},
      byId(ours),
      byId(theirs),
      path,
      conflicts,
    );
    return Object.values(merged);
  }

  conflicts.push(path);
  return ours;
};

const mergeObjects = (
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  conflicts: string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};

  for (const key of Array.from(new Set([...Object.keys(ours), ...Object.keys(theirs)]))) {
    const here = key in ours;
    const there = key in theirs;
    const existed = key in base;

    // A deletion on one side and no change on the other is a deletion.
    if (!here) {
      if (existed && same(base[key], theirs[key])) continue;
      out[key] = theirs[key];
      continue;
    }
    if (!there) {
      if (existed && same(base[key], ours[key])) continue;
      out[key] = ours[key];
      continue;
    }

    out[key] = mergeValue(base[key], ours[key], theirs[key], `${path}${path ? "." : ""}${key}`, conflicts);
  }

  return out;
};

/**
 * Merges three versions of the bundle.
 *
 * `revision` is not merged -- it is a compare-and-swap counter, and the merged
 * file is a new state that neither side has seen. It becomes the higher of the
 * two plus one, so the next write from either clone still collides correctly.
 */
export const mergeBundles = (baseText: string, oursText: string, theirsText: string): MergeResult => {
  let base: unknown, ours: unknown, theirs: unknown;
  try {
    base = JSON.parse(baseText || "{}");
    ours = JSON.parse(oursText);
    theirs = JSON.parse(theirsText);
  } catch {
    return { merged: null, conflicts: ["<the file is not valid JSON>"] };
  }
  if (!isObject(ours) || !isObject(theirs)) {
    return { merged: null, conflicts: ["<not a project bundle>"] };
  }

  // `revision` and `updatedAt` are the merge's own bookkeeping, and both change
  // on every single write -- so both sides have always moved them, and leaving
  // them in would report a conflict on every merge that ever happens. They are
  // held out and recomputed below.
  const conflicts: string[] = [];
  const merged = mergeObjects(
    withoutBookkeeping(isObject(base) ? base : {}),
    withoutBookkeeping(ours),
    withoutBookkeeping(theirs),
    "",
    conflicts,
  );

  const revisions = [ours.revision, theirs.revision].filter(
    (r): r is number => typeof r === "number",
  );
  // Past both, so the next write from either clone still collides correctly.
  merged.revision = revisions.length ? Math.max(...revisions) + 1 : 1;
  merged.updatedAt = new Date().toISOString();

  return { merged, conflicts };
};
