/**
 * `withAdvisoryLock` against a REAL Postgres pool (DATABASE_URL): the lock is
 * held while `fn` runs, as another connection sees it, and released after,
 * whether `fn` returns or throws. The leak it replaces (27 Oct 2026) left the
 * lock on an idle pooled connection; "held after" is that defect.
 * Needs a live Postgres (PGlite cannot show it, being one connection): probed
 * once at load, as entities-dedup-gate.test.ts does, so a missing database is
 * reported SKIPPED (with the probe's own test always run), never PASSED.
 */
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "../client-pg.js";
import { withAdvisoryLock } from "../advisory-lock.js";

async function probe(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
const dbAvailable = await probe();

const K1 = `advisory-lock-live-test:${process.pid}`;
const K2 = `run:${Date.now()}`;

/** Does ANOTHER connection see the lock as taken? (try + immediate release) */
async function heldElsewhere(): Promise<boolean> {
  const other = await sql.reserve();
  try {
    const [row] = await other<{ got: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${K1}), hashtext(${K2})) AS got`;
    if (row!.got)
      await other`SELECT pg_advisory_unlock(hashtext(${K1}), hashtext(${K2}))`;
    return !row!.got;
  } finally {
    other.release();
  }
}

// Never gated: the probe ran, so the skips below are honest.
describe("withAdvisoryLock — live-PG gate", () => {
  it("probed the database", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe.skipIf(!dbAvailable)("withAdvisoryLock (live pool)", () => {
  it("holds the lock while fn runs, releases it after", async () => {
    let during: boolean | undefined;
    const out = await withAdvisoryLock(K1, K2, async () => {
      // Churn the pool so the door could not get away with "the same
      // connection by luck".
      await Promise.all(
        Array.from({ length: 8 }, () => sql`SELECT pg_sleep(0.02)`)
      );
      during = await heldElsewhere();
      return 42;
    });
    expect(out).toBe(42);
    expect(during).toBe(true);
    expect(await heldElsewhere()).toBe(false);
  });

  it("releases the lock when fn throws", async () => {
    await expect(
      withAdvisoryLock(K1, K2, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await heldElsewhere()).toBe(false);
  });
});
