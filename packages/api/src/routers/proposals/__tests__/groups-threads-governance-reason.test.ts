import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — the `groups` procedure must SELECT `governanceReason` and THREAD it
 * into the `ClusterInputRow` it builds.
 *
 * Why source-level: `ClusterInputRow.governanceReason` is optional (it must be —
 * older callers populate none), so dropping either half is invisible to `tsc`.
 * Verified: deleting the threading line produces **zero** typecheck errors. The
 * pure `collapseProposalsToClusters` tests cannot see it either, because they
 * construct rows with the field already set. Between those two facts the field
 * can silently stop flowing while every existing gate stays green — the exact
 * shape of the severed-field defects this codebase keeps finding.
 *
 * What it protects: `governance_reason` is NOT type-determined. A write that
 * reached review only because rung 2.55 flagged its instruction as
 * UNTRUSTED_ORIGIN (prompt-injection provenance), or because it hit the rung-2.5
 * DESTRUCTIVE floor, fingerprints IDENTICALLY to a routine one. Without this
 * column on the cluster, a review UI cannot warn that a group contains the very
 * item the floor exists to surface — and a group decision would sweep it in.
 *
 * If this fails: restore the select/threading. Do not relax the assertion.
 */

const ROUTER = join(process.cwd(), "src/routers/proposals.ts");

describe("proposals.groups carries the escalation cause", () => {
  it("can see the router it pins", () => {
    expect(existsSync(ROUTER), `${ROUTER} moved — fix this path`).toBe(true);
  });

  const src = existsSync(ROUTER) ? readFileSync(ROUTER, "utf8") : "";

  /** The `groups` procedure body: from its declaration to the next procedure. */
  function groupsBody(): string {
    const start = src.indexOf("groups: protectedProcedure");
    expect(start, "`groups: protectedProcedure` not found").toBeGreaterThan(-1);
    // Bounded by the next top-level procedure rather than a magic char count —
    // a fixed slice silently drifts past what it pins as the file grows, which
    // has already produced one stale tripwire in this repo.
    const next = src.indexOf(": protectedProcedure", start + 30);
    return next === -1 ? src.slice(start) : src.slice(start, next);
  }

  it("SELECTS proposals.governanceReason", () => {
    expect(
      /governanceReason:\s*proposals\.governanceReason/.test(groupsBody()),
      "the groups query stopped selecting the escalation cause"
    ).toBe(true);
  });

  it("THREADS it into the ClusterInputRow (the half tsc cannot check)", () => {
    const body = groupsBody();
    const mapStart = body.indexOf("const clusterRows");
    expect(mapStart, "clusterRows mapping not found").toBeGreaterThan(-1);
    const mapping = body.slice(mapStart, body.indexOf("}));", mapStart));
    expect(
      /governanceReason:\s*r\.governanceReason/.test(mapping),
      "governanceReason is selected but NOT passed into ClusterInputRow — the " +
        "cluster silently loses every floor signal, and tsc reports nothing " +
        "because the field is optional"
    ).toBe(true);
  });
});
