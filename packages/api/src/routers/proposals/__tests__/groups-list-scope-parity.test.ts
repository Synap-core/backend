/**
 * `proposals.groups` gains the scope filters `proposals.list` already has
 * (P3), so a container package can show pending/decided COUNTS for the same
 * scope its rows come from, without the two doors drifting apart.
 *
 * Why source-level, following `groups-threads-governance-reason.test.ts`'s
 * pattern: a live DB isn't available in this suite, and the risk this guards
 * against — `list` and `groups` silently re-diverging into two hand-rolled
 * predicates — is invisible to `tsc` (both compile fine either way) and to a
 * unit test of `buildProposalScopeConditions` alone (that only proves the
 * shared function is correct, not that both procedures actually CALL it
 * instead of re-inlining their own copy). Pinning the call site is the only
 * thing that catches a future edit that reintroduces a second predicate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildProposalScopeConditions,
  resolveAutomationStepRunIds,
} from "../scope-conditions.js";

const ROUTER = join(process.cwd(), "src/routers/proposals.ts");
const SCOPE_FILE = join(
  process.cwd(),
  "src/routers/proposals/scope-conditions.ts"
);

function readSrc(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Bounded the same way the governance-reason tripwire bounds `groups`. */
function procedureBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  const next = src.indexOf(": protectedProcedure", start + 30);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("proposals.list and proposals.groups share ONE scope predicate", () => {
  const src = readSrc(ROUTER);

  it("both files exist where pinned", () => {
    expect(existsSync(ROUTER)).toBe(true);
    expect(existsSync(SCOPE_FILE)).toBe(true);
  });

  it("`list` calls buildProposalScopeConditions instead of re-inlining it", () => {
    const body = procedureBody(src, "list: protectedProcedure");
    expect(body).toContain("buildProposalScopeConditions(");
    // The old hand-rolled workspace three-state must be GONE from `list`,
    // not just duplicated alongside the shared call.
    expect(body).not.toContain("userVisibleWhere(proposals.workspaceId");
  });

  it("`groups` calls the SAME buildProposalScopeConditions, not a second copy", () => {
    const body = procedureBody(src, "groups: protectedProcedure");
    expect(body).toContain("buildProposalScopeConditions(");
    expect(body).not.toContain("userVisibleWhere(proposals.workspaceId");
  });

  it("`groups` input accepts the filters `list` already has", () => {
    const body = procedureBody(src, "groups: protectedProcedure");
    for (const field of [
      "targetType",
      "threadId",
      "sessionId",
      "projectId",
      "automationId",
    ]) {
      expect(
        new RegExp(`\\b${field}:\\s*z[\\s\\S]{0,20}\\.`).test(body),
        `groups input is missing "${field}"`
      ).toBe(true);
    }
  });

  it("`groups` resolves automationId the same way `list` does", () => {
    for (const marker of [
      "list: protectedProcedure",
      "groups: protectedProcedure",
    ]) {
      const body = procedureBody(src, marker);
      expect(body).toContain("resolveAutomationStepRunIds(");
      expect(body).toContain("inArray(proposals.stepRunId, stepRunIds)");
    }
  });

  it("only ONE definition of the shared predicate builder exists", () => {
    const defs = src.match(/function buildProposalScopeConditions/g) ?? [];
    expect(defs.length).toBe(0); // it must live in scope-conditions.ts, not the router
    const scopeSrc = readSrc(SCOPE_FILE);
    expect(
      (scopeSrc.match(/export function buildProposalScopeConditions/g) ?? [])
        .length
    ).toBe(1);
  });
});

describe("buildProposalScopeConditions", () => {
  it("is exported and callable with the shared input shape", () => {
    expect(typeof buildProposalScopeConditions).toBe("function");
    const conditions = buildProposalScopeConditions(
      {
        workspaceId: "ws-1",
        targetType: "entity",
        threadId: "thread-1",
        sessionId: "session-1",
        projectId: "project-1",
        agentUserId: "agent-1",
        agentOnly: true,
      },
      "user-1"
    );
    // One SQL condition per populated filter (workspace + 6 optional filters).
    expect(conditions.length).toBe(7);
  });

  it("workspaceId: null narrows to pod-wide only (isNull), not the user floor", () => {
    const withNull = buildProposalScopeConditions(
      { workspaceId: null },
      "user-1"
    );
    const withUndefined = buildProposalScopeConditions({}, "user-1");
    // Both compile to exactly one workspace condition, but they must not be
    // the same SQL — this is the three-state contract `list` documents.
    expect(withNull.length).toBe(1);
    expect(withUndefined.length).toBe(1);
    expect(withNull[0]!.queryChunks).not.toEqual(withUndefined[0]!.queryChunks);
  });

  it("emits no conditions beyond the user floor when every filter is absent", () => {
    const conditions = buildProposalScopeConditions({}, "user-1");
    expect(conditions.length).toBe(1); // just the workspace-floor predicate
  });
});

describe("resolveAutomationStepRunIds", () => {
  it("is exported as an async function (the join, not a column read)", () => {
    expect(typeof resolveAutomationStepRunIds).toBe("function");
    expect(resolveAutomationStepRunIds.constructor.name).toBe("AsyncFunction");
  });
});
