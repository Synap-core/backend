import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSAL_BATCH_MAX } from "./index.js";

/**
 * ONE source for the batch cap: the router validates with the constant, never
 * a literal — so a raised or lowered cap reaches every client that slices with
 * it. Source scan of the router (the api package is not importable here).
 */
describe("PROPOSAL_BATCH_MAX is the router's own limit", () => {
  const router = readFileSync(
    resolve(__dirname, "../../../api/src/routers/proposals.ts"),
    "utf8"
  );

  it("is 50", () => {
    expect(PROPOSAL_BATCH_MAX).toBe(50);
  });

  it("both batch doors validate with it, and no batch door spells a literal cap", () => {
    expect(router.match(/proposalIds: z\.array\(z\.string\(\)\)\.min\(1\)\.max\(PROPOSAL_BATCH_MAX\)/g)).toHaveLength(2);
    expect(router).not.toMatch(/proposalIds: z\.array\(z\.string\(\)\)\.min\(1\)\.max\(\d+\)/);
  });
});
