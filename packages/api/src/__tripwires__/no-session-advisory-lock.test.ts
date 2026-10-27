/**
 * TRIPWIRE — no SESSION-level Postgres advisory lock in backend source.
 *
 * WHY (27 Oct 2026). `withWorkspaceProposalIdLock` (template-apply/layer-one.ts)
 * took `pg_advisory_lock` with one `db.execute` and released it with another.
 * `db` is a connection pool: the unlock ran on a different connection (a no-op
 * there) and the lock stayed held by an idle pooled connection. Every approve
 * of the CRM update then waited on it, silently, until the holder was ended.
 * A session lock is only safe on ONE pinned connection, and this codebase
 * reaches Postgres through the pool, so the rule is: take an advisory lock
 * inside a transaction with `pg_advisory_xact_lock` (released at commit or
 * rollback), as oauth/refresh.ts and onboarding.ts do.
 *
 * HOW (derived): walk every `packages/<pkg>/src` and `apps/<app>/src` (tests
 * skipped, comments blanked) and fail on any call to `pg_advisory_lock`,
 * `pg_advisory_lock_shared`, `pg_try_advisory_lock(_shared)` or
 * `pg_advisory_unlock(_shared|_all)`.
 *
 * WHAT IT DOES NOT SEE (stated): a lock function name built at run time, or SQL
 * read from a file outside these roots (migrations are SQL files, not scanned).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

const ROOTS = ["packages", "apps"].flatMap((top) =>
  readdirSync(join(REPO, top))
    .map((name) => join(REPO, top, name, "src"))
    .filter((dir) => existsSync(dir))
);

/** A session-level advisory lock or unlock call; the `_xact_` forms do not match. */
const SESSION_LOCK =
  /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\s*\(/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      /\.(ts|mts|js|mjs)$/.test(name) &&
      !/\.test\.(ts|mts|js|mjs)$/.test(name) &&
      !name.endsWith(".d.ts")
    )
      out.push(full);
  }
  return out;
}

let scanned = 0;
const offenders: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++;
    const lines = stripComments(readFileSync(file, "utf8"), "ts").split("\n");
    lines.forEach((line, i) => {
      if (SESSION_LOCK.test(line))
        offenders.push(`${relative(REPO, file)}:${i + 1}`);
    });
  }
}

describe("advisory locks are transaction-scoped", () => {
  it("scans real code and recognises a session lock (non-vacuity)", () => {
    expect(ROOTS.length).toBeGreaterThan(10);
    expect(scanned).toBeGreaterThan(1000);
    expect(SESSION_LOCK.test("SELECT pg_advisory_lock(hashtext($1))")).toBe(
      true
    );
    expect(SESSION_LOCK.test("select pg_advisory_unlock(1, 2)")).toBe(true);
    expect(SESSION_LOCK.test("select pg_try_advisory_lock(1)")).toBe(true);
    expect(SESSION_LOCK.test("select pg_advisory_xact_lock(hashtext($1))")).toBe(
      false
    );
  });

  it("no source file takes a session-level advisory lock", () => {
    expect(
      offenders,
      "A session advisory lock through the pool can be released on another connection and leak. Use pg_advisory_xact_lock inside db.transaction."
    ).toEqual([]);
  });
});
