/**
 * Every rate-limit budget the code reads must reach a deployed pod.
 *
 * The backend container sees only the keys `deploy/docker-compose.yml` passes
 * (`x-backend-env`), and `synap config set` refuses a key `deploy/env.schema`
 * does not list. A `RATE_LIMIT_*` key read here but missing from either is
 * tunable in dev and silently ignored on every pod: `RATE_LIMIT_CRUD_MAX`
 * was, so the agent-key budget could not be raised (2026-10-27).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (rel: string) => readFileSync(repoRoot + rel, "utf8");

const codeKeys = [
  ...new Set(
    read("apps/api/src/middleware/rate-limit-classes.ts").match(
      /\bRATE_LIMIT_[A-Z_]+\b/g
    ) ?? []
  ),
].sort();

describe("rate-limit budgets reach a deployed pod", () => {
  it("finds the budgets the code reads", () => {
    expect(codeKeys).toContain("RATE_LIMIT_CRUD_MAX");
    expect(codeKeys.length).toBeGreaterThanOrEqual(20);
  });

  it("docker-compose passes every one to the backend", () => {
    const compose = read("deploy/docker-compose.yml");
    const missing = codeKeys.filter(
      (k) => !compose.includes(`${k}: \${${k}:-}`)
    );
    expect(missing).toEqual([]);
  });

  it("env.schema lets `synap config set` write every one", () => {
    const schema = new Set(
      read("deploy/env.schema")
        .split("\n")
        .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
        .map((l) => l.trim().split(/\s+/)[0])
    );
    expect(codeKeys.filter((k) => !schema.has(k))).toEqual([]);
  });
});
