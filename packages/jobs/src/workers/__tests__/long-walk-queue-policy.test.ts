/**
 * Tripwire for the 2026-07-31 duplicate-execution defect.
 *
 * pg-boss 10.4.2 gives every queue a default `expire_in` of 15 minutes
 * (`src/plans.js:192`). `failJobsByTimeout` (`src/plans.js:566`) then DELETEs the
 * active row and re-INSERTs it as a retry WHILE the Node handler is still
 * running. Combined with the boss.ts default `retryLimit: 3`, an
 * `automation-execute` DAG walk over 15 minutes executed up to FOUR times
 * concurrently — duplicating every `entity_create` (which, unlike `notification`
 * and `channel_message`, carries no `outputIdemId`).
 *
 * Why this is a SOURCE test rather than a behavioural one: the fix is a queue
 * POLICY, applied once at boot inside `registerAllWorkers()`. Importing
 * `workers/index.ts` transitively boots the entire worker registry (db, search,
 * every handler), so a behavioural test would be slower and flakier than the
 * thing it guards — and would still only prove that a mock received an object.
 * The invariants below are what a future edit would silently break, and they are
 * checkable exactly where they live. Same precedent as the source-grep
 * assertions in `ledger-query-scope.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REAPER_STALE_MINUTES } from "../automation-run-reaper.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "../index.ts"), "utf8");

/** `new Map<string, number>([["automation-execute", 2400]])` → 2400 */
function longWalkExpiryFor(queue: string): number | null {
  const block = indexSrc.match(
    /const LONG_WALK_QUEUES[\s\S]*?\]\s*\)\s*;/
  )?.[0];
  if (!block) return null;
  const entry = block.match(new RegExp(`\\["${queue}",\\s*([0-9_]+)\\]`))?.[1];
  return entry ? Number(entry.replace(/_/g, "")) : null;
}

describe("long-walk queue policy (automation-execute)", () => {
  const expiry = longWalkExpiryFor("automation-execute");

  it("gives automation-execute an EXPLICIT expiry — never pg-boss's 15-min default", () => {
    // The whole defect: 900s is shorter than a realistic DAG walk. One
    // `ai.generate` step alone is now up to 4 × 180s = 720s (per-step retry loop
    // × the `generation` budget), so two AI steps clear 900s trivially.
    expect(expiry).not.toBeNull();
    expect(expiry!).toBeGreaterThan(900);
  });

  it("keeps that expiry BELOW the run reaper's threshold, so ordering stays sane", () => {
    // THE constraint that makes this policy correct, and the one most likely to
    // be broken by someone "just raising the timeout":
    //
    //   expiry < reaper  →  pg-boss fails the job first, THEN the reaper
    //                       finalizes the run row and posts the summary.
    //   expiry > reaper  →  the reaper marks a STILL-EXECUTING run `failed`,
    //                       and a run that actually completed is reported as a
    //                       failure.
    //
    // Reading REAPER_STALE_MINUTES from its module (not a copied literal) means
    // changing the reaper's threshold fails THIS test too — which is correct,
    // because the two numbers are only meaningful relative to each other.
    expect(expiry!).toBeLessThan(REAPER_STALE_MINUTES * 60);
  });

  it("sets retryLimit 0 — closing duplicate execution by construction, not by a number", () => {
    // `retryLimit: 0` is the load-bearing half. An expiry large enough for
    // today's longest walk is a number that must STAY larger than every future
    // walk; every budget raise would silently re-open the defect. retryLimit 0
    // means a reclaim can never redeliver, at any walk length.
    expect(indexSrc).toMatch(
      /longWalkExpiry !== undefined[\s\S]*?retryLimit:\s*0[\s\S]*?expireInSeconds/
    );
  });

  it("forces the policy through updateQueue — createQueue alone is a NO-OP on a live pod", () => {
    // pg-boss's createQueue is `ON CONFLICT DO NOTHING`. `automation-execute`
    // already exists on every deployed pod carrying the inherited 15-min/retry-3
    // policy, so WITHOUT this updateQueue the entire fix deploys as a no-op and
    // every gate here still passes. This assertion is the difference between
    // "the code is right" and "the pod is fixed".
    expect(indexSrc).toMatch(
      /if\s*\(policy\)\s*\{\s*await boss\.updateQueue\(/
    );
  });
});
