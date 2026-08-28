/**
 * A test harness small enough to read in one sitting.
 *
 * The repo had no tests at all, and the pieces that most need them -- the
 * markdown round-trip and the git attribution -- are exactly the ones where a
 * silent wrong answer destroys a user's work. This is deliberately dependency
 * free: `node:assert` plus esbuild, both already present.
 */

export type Test = { name: string; run: () => void | Promise<void> };

const tests: Test[] = [];

export const test = (name: string, run: () => void | Promise<void>) => {
  tests.push({ name, run });
};

export const eq = <T>(actual: T, expected: T, message?: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message ? message + ": " : ""}expected ${b}, got ${a}`);
  }
};

export const ok = (value: unknown, message = "expected truthy") => {
  if (!value) throw new Error(message);
};

export const throws = (fn: () => unknown, match: RegExp, message = "expected a throw") => {
  try {
    fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!match.test(text)) {
      throw new Error(`${message}: message ${JSON.stringify(text)} does not match ${match}`);
    }
    return;
  }
  throw new Error(message);
};

export const runAll = async (): Promise<number> => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      process.stdout.write(`  ok   ${t.name}\n`);
    } catch (error) {
      failed++;
      const text = error instanceof Error ? error.message : String(error);
      process.stdout.write(`  FAIL ${t.name}\n       ${text}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} passed\n`);
  return failed;
};
