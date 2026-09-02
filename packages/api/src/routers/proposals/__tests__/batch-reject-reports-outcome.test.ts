import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — `batchReject` must report outcome telemetry, like `reject` does.
 *
 * The asymmetry this locks: the APPROVE side reports from the executor layer
 * (`reportApproved` in `executors/shared.ts`, called by 24 executors), so it
 * fires on the batch door automatically. REJECT reports at the router, and only
 * the single-item procedure ever did — so every bulk approval reached IS
 * telemetry and every bulk rejection was dropped.
 *
 * The consequence is not a missing metric, it is a BIASED CORPUS: the signal a
 * model learns from saw the agent work a human accepted and never the work a
 * human refused. Rejections are the more informative half.
 *
 * Source-level because invoking the procedure needs a live Postgres (the local
 * DB is down — 63 of this repo's suite's failures are `ECONNREFUSED :5432`), and
 * because the call is fire-and-forget: deleting it fails no assertion anywhere
 * and leaves `tsc` green.
 */

const ROUTER = join(process.cwd(), "src/routers/proposals.ts");

describe("batchReject reports outcomes", () => {
  it("can see the router it pins", () => {
    expect(existsSync(ROUTER), `${ROUTER} moved — fix this path`).toBe(true);
  });

  const src = existsSync(ROUTER) ? readFileSync(ROUTER, "utf8") : "";

  /** The `batchReject` procedure body, bounded by the next top-level procedure. */
  function batchRejectBody(): string {
    const start = src.indexOf("batchReject: protectedProcedure");
    expect(
      start,
      "`batchReject: protectedProcedure` not found"
    ).toBeGreaterThan(-1);
    const next = src.indexOf(": protectedProcedure", start + 30);
    return next === -1 ? src.slice(start) : src.slice(start, next);
  }

  it("calls reportProposalOutcome with a rejected outcome", () => {
    const body = batchRejectBody();
    expect(
      /reportProposalOutcome\(\{/.test(body) &&
        /outcome:\s*"rejected"/.test(body),
      "bulk rejections are invisible to telemetry again — the learning corpus " +
        "goes back to seeing only approvals"
    ).toBe(true);
  });

  it("selects the columns that report needs, rather than re-reading per item", () => {
    const body = batchRejectBody();
    for (const col of ["targetType", "sourceMessageId"]) {
      expect(
        new RegExp(`${col}:\\s*true`).test(body),
        `${col} dropped from the batch select — the report would go out with ` +
          `undefined, or a caller would add an N+1 read to recover it`
      ).toBe(true);
    }
  });
});
