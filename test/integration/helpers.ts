import type { Source } from '../../src/engines/source.js';

/**
 * Shared helpers for the integration suite.
 *
 * The integration tests need live Postgres and MySQL. On a machine without
 * Docker they are unreachable, and the suite has to survive that — but it must
 * not pretend the tests ran.
 */

/**
 * Connects to a source, returning null when it is not reachable.
 *
 * A skipped test that reports as *passed* is worse than no test at all: it
 * hides a broken engine behind a green build. The tests therefore mark
 * themselves skipped through `skipTest`, which makes the count of skipped
 * tests visible in the output.
 */
export async function tryConnect(fn: () => Promise<Source>): Promise<Source | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Marks the current test as skipped, with a reason.
 *
 * Calling this aborts the test body, so the assertions after it do not run.
 * The reason is shown in the test output, so a reader can tell that a test
 * was not exercised rather than having passed.
 */
export function skipTest(ctx: { skip: (note?: string) => never }, reason: string): never {
  return ctx.skip(reason);
}
