/**
 * The dependency graph the code actually has, and how it differs from the one
 * the canvas claims.
 *
 * ---- why this is not a full parser ----
 *
 * A symbol-level graph needs tree-sitter, a WASM grammar per language and an
 * incremental index. The thing worth having first is smaller than that: which
 * parts of the system reach into which other parts. Imports answer exactly that
 * and are among the few constructs extractable without a parser, because their
 * syntax is rigid and they sit at the top of the file.
 *
 * So this is a dependency graph, not a symbol graph, and the difference matters
 * when reading its output. It sees `import`, `export from`, `require` and
 * dynamic `import()`. It does not see a service calling another over HTTP, and
 * it never will.
 *
 * ---- what that means for drift ----
 *
 * Undeclared coupling is a real finding: the code imports across a boundary the
 * architecture does not draw, and one of the two is wrong. A declared edge with
 * no import is NOT a finding -- it is very often a network call, a queue, or a
 * relationship that was never going to appear in an import statement. Reporting
 * those as drift would bury the ones that matter under the ones that never
 * could, so they are kept separate and described as unverifiable rather than as
 * violations.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import { resolveComponent, type Component } from "./component";

const SOURCE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
  ".project-cache",
]);

// `[^;]` rather than `[^;\n]`, and the difference is not cosmetic: a named
// import list spans several lines, which is how most non-trivial imports are
// written, and a newline-bounded pattern silently misses every one of them.
// A semicolon reliably ends the statement; the length bound keeps a file
// without semicolons from causing pathological backtracking.
const FROM_CLAUSE = /(?:^|\n)\s*(?:import|export)[^;]{0,600}?from\s*["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const CALL_FORM = /(?:^|[^.\w])(?:require|import)\s*\(\s*["']([^"']+)["']/g;

/**
 * Every import specifier in a file.
 *
 * Three patterns rather than one, because a single expression covering all of
 * them needs backtracking across the whole file and gets slow on a large one.
 *
 * A commented-out import matches, and that is an acceptable trade: a spurious
 * edge between two components that already import each other changes nothing,
 * and stripping comments correctly means writing the lexer this module exists
 * to avoid.
 */
export const importsIn = (source: string): string[] => {
  const found = new Set<string>();
  for (const pattern of [FROM_CLAUSE, BARE_IMPORT, CALL_FORM]) {
    // A fresh regex per call: these are global, and a shared `lastIndex` across
    // files would make the graph depend on the order the files were read in.
    const scan = new RegExp(pattern.source, "g");
    let match: RegExpExecArray | null;
    while ((match = scan.exec(source)) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  return Array.from(found);
};

/** Every source file under `root`, repo-relative. */
export const sourceFiles = (root: string, dir = root, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    // Dotted directories are tooling, not architecture -- with the exception of
    // the agent directories, which is where a skill or a hook script lives.
    if (entry.startsWith(".") && !entry.startsWith(".claude")) continue;
    if (SKIP.has(entry)) continue;

    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) sourceFiles(root, path, out);
    else if (SOURCE.has(extname(entry))) out.push(relative(root, path));
  }
  return out;
};

/**
 * Turns a specifier into the repo-relative file it names, or nothing.
 *
 * Handles the two forms that point inside the project -- relative paths and the
 * `@/` alias this repo uses -- and deliberately drops everything else. A bare
 * specifier is a package, and a package is not part of the architecture the
 * canvas draws.
 */
export const resolveSpecifier = (
  root: string,
  fromFile: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | undefined => {
  let base: string;
  if (specifier.startsWith(".")) base = resolve(root, dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) base = resolve(root, specifier.slice(2));
  else return undefined;

  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((ext) => base + ext),
    ...[".ts", ".tsx", ".js", ".jsx"].map((ext) => join(base, "index" + ext)),
  ];
  const hit = candidates.find((path) => exists(path));
  return hit ? relative(root, hit) : undefined;
};

export type DependencyEdge = {
  from: string;
  to: string;
  /** How many files import across this boundary, and a few of them by name. */
  count: number;
  examples: { from: string; to: string }[];
};

export type GraphOptions = {
  files?: string[];
  read?: (path: string) => string;
  exists?: (path: string) => boolean;
};

/**
 * Component-to-component edges, from the imports between their files.
 *
 * A file belonging to no component is skipped rather than guessed at, and an
 * import inside one component is not an edge -- the graph is about boundaries
 * being crossed, and a component depending on itself is just a component.
 */
export const dependencyGraph = (
  root: string,
  components: readonly Component[],
  options: GraphOptions = {},
): DependencyEdge[] => {
  const files = options.files ?? sourceFiles(root);
  const read = options.read ?? ((path: string) => readFileSync(join(root, path), "utf8"));
  const exists =
    options.exists ??
    ((path: string) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });

  const edges = new Map<string, DependencyEdge>();

  for (const file of files) {
    const owner = resolveComponent(file, components)?.componentId;
    if (!owner) continue;

    let source: string;
    try {
      source = read(file);
    } catch {
      continue;
    }

    for (const specifier of importsIn(source)) {
      const target = resolveSpecifier(root, file, specifier, exists);
      if (!target) continue;
      const other = resolveComponent(target, components)?.componentId;
      if (!other || other === owner) continue;

      const key = owner + " " + other;
      const edge = edges.get(key) ?? { from: owner, to: other, count: 0, examples: [] };
      edge.count += 1;
      if (edge.examples.length < 3) edge.examples.push({ from: file, to: target });
      edges.set(key, edge);
    }
  }

  return Array.from(edges.values()).sort((a, b) => b.count - a.count);
};

export type Drift = {
  /** The code crosses a boundary the architecture does not draw. */
  undeclared: DependencyEdge[];
  /**
   * The architecture draws a relation no import backs.
   *
   * Not a violation. An import graph cannot see an HTTP call or a queue, so
   * most of these are simply relationships it was never going to observe.
   */
  unverifiable: { from: string; to: string }[];
};

/**
 * What the canvas claims, against what the code does.
 *
 * Declared edges are read as undirected. An architecture diagram's arrow means
 * "these are connected" far more often than it means "and only in this
 * direction", and reporting a backwards arrow as drift would train people to
 * ignore the output.
 */
export const drift = (
  declared: readonly { from: string; to: string }[],
  actual: readonly DependencyEdge[],
): Drift => {
  const pair = (a: string, b: string) => [a + " " + b, b + " " + a];
  const claimed = new Set(declared.flatMap((e) => pair(e.from, e.to)));
  const real = new Set(actual.flatMap((e) => pair(e.from, e.to)));

  return {
    undeclared: actual.filter((e) => !claimed.has(e.from + " " + e.to)),
    unverifiable: declared.filter((e) => !real.has(e.from + " " + e.to)),
  };
};
