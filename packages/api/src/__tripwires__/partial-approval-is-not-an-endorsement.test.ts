import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ProposalStatus, proposals } from "@synap/database";
import {
  resolveStatusLabel,
  humanizeToken,
} from "@synap-core/types/vocabulary";
import { computeAgentScorecard } from "../services/diagnose/agent-scorecard.js";
import type { ScorecardProposalRow } from "../services/diagnose/agent-scorecard.js";

/**
 * PARTIAL-APPROVAL-IS-NOT-AN-ENDORSEMENT TRIPWIRE
 *
 * INVARIANT: no trust counter may score a PARTIALLY applied proposal as a full
 * approval.
 *
 * Partial approval ships as per-item dispositions: a reviewer denies individual
 * items inside a composite proposal and approves the rest. Deliberately, there
 * is NO new `proposals.status` value and no migration — the row stores plain
 * `"approved"` and the decision lives in `data.dispositions`. So `status` alone
 * cannot distinguish "kept 1 of 30" from "kept 30 of 30", and every reader that
 * scores an agent MUST also ask the dispositions question.
 *
 * This matters most where the answer GRANTS AUTONOMY. The widening lane scanner
 * fires at `total >= 100 && approveRate > 0.95`: an agent whose packages are
 * routinely gutted would read 100% and earn a wider auto-approve lane — trust
 * granted on a signal that means the opposite of what it was counted as. The
 * daily-cap trust check (`agentDailyProposalCap`, 3x ceiling) has the same
 * shape.
 *
 * Behavioural half: `computeAgentScorecard` is pure, so it is exercised
 * directly. Source half: the jobs-package scanner and the permission-check cap
 * cannot be imported here (module-level `@synap/database`), so their routing is
 * frozen at source level, the way the other __tripwires__ do it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, ".."); // packages/api/src
const JOBS_SRC = join(HERE, "..", "..", "..", "jobs", "src");
const read = (abs: string) => readFileSync(abs, "utf8");

function row(over: Partial<ScorecardProposalRow>): ScorecardProposalRow {
  return {
    proposalType: "create_composite",
    targetType: "entity",
    targetId: "t1",
    data: { title: "Acme" },
    status: "approved",
    rejectionReason: null,
    reasonCode: null,
    revisionHistory: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    workspaceId: "ws1",
    ...over,
  };
}

/** A composite whose reviewer denied one item — the row is still "approved". */
const GUTTED = {
  title: "Acme",
  dispositions: {
    $op0: { status: "accept" },
    $op1: { status: "reject", reasonCode: "wrong_target" },
  },
};

describe("partial approval is not an endorsement — scorecard", () => {
  it("does NOT count a gutted composite as approved", () => {
    const card = computeAgentScorecard([row({ targetId: "a", data: GUTTED })], {
      agentId: "a1",
      agentName: null,
      agentType: null,
      todayCount: 0,
    });
    expect(card.counts.approved).toBe(0);
    expect(card.counts.partiallyApproved).toBe(1);
    expect(card.rates.approveRate).toBe(0);
  });

  it("scores 1-of-2-gutted BELOW 2 clean approvals", () => {
    const clean = computeAgentScorecard(
      [row({ targetId: "a" }), row({ targetId: "b" })],
      { agentId: "a1", agentName: null, agentType: null, todayCount: 0 }
    );
    const gutted = computeAgentScorecard(
      [row({ targetId: "a" }), row({ targetId: "b", data: GUTTED })],
      { agentId: "a1", agentName: null, agentType: null, todayCount: 0 }
    );
    expect(clean.rates.approveRate).toBe(1);
    expect(gutted.rates.approveRate).toBeLessThan(clean.rates.approveRate);
    expect(gutted.counts.approved).toBe(1);
    expect(gutted.counts.partiallyApproved).toBe(1);
  });

  it("an all-accept disposition map is still a full approval", () => {
    const card = computeAgentScorecard(
      [row({ data: { dispositions: { $op0: { status: "accept" } } } })],
      { agentId: "a1", agentName: null, agentType: null, todayCount: 0 }
    );
    expect(card.counts.approved).toBe(1);
    expect(card.counts.partiallyApproved).toBe(0);
  });
});

describe("partial approval is not an endorsement — widening gate (source)", () => {
  const scanner = read(join(JOBS_SRC, "workers", "governance-lane-scanner.ts"));

  it("the scanner's approve-rate goes through the partial-aware predicate", () => {
    // ONE definition of "approved" for both the rate and the dominant motif.
    expect(scanner).toMatch(/function isFullApproval\(/);
    expect(scanner).toMatch(/isPartiallyApprovedData\(r\.data\)/);
    expect(scanner).toMatch(/rows\.filter\(isFullApproval\)/);
    // Exactly two consumers of the predicate: computeQualification's numerator
    // and computeDominantMotif's evidence set.
    expect(scanner.match(/rows\.filter\(isFullApproval\)/g)).toHaveLength(2);
  });

  it("no status-only approval test survives in the scanner", () => {
    // The old shape: a bare `r.status === APPROVED || r.status === AUTO_APPROVED`
    // filter with no disposition check. It may now appear ONLY inside
    // isFullApproval.
    const occurrences = scanner.match(
      /r\.status === ProposalStatus\.APPROVED/g
    );
    expect(occurrences).toHaveLength(1);
  });
});

describe("partial approval is not an endorsement — daily-cap trust (source)", () => {
  const permissionCheck = read(join(API_SRC, "utils", "permission-check.ts"));

  it("agentDailyProposalCap excludes partial applies from its approve rate", () => {
    const cap = permissionCheck.slice(
      permissionCheck.indexOf("export async function agentDailyProposalCap")
    );
    expect(cap).toMatch(/isPartial/);
    expect(cap).toMatch(/!r\.isPartial &&/);
  });

  it("the cap's partial predicate matches the scorecard's SQL predicate", () => {
    // One question asked in two SQL sites — they must stay byte-identical.
    const scorecard = read(
      join(API_SRC, "services", "diagnose", "agent-scorecard.ts")
    );
    const PREDICATE =
      "jsonb_path_exists(${proposals.data}, '$.dispositions.*.status ? (@ == \"reject\")')";
    expect(permissionCheck).toContain(PREDICATE);
    expect(scorecard).toContain(PREDICATE);
  });
});

describe("`partially_approved` is a LABEL, never a proposals.status value", () => {
  /**
   * The vocabulary SSOT carries `partially_approved: "Partially approved"` so
   * the trust grid and the agent dossier name the concept with ONE word instead
   * of two hand-written strings. It is deliberately NOT a `proposals.status`
   * value: partial approval ships as per-item dispositions, the row keeps
   * storing `approved`, and the reviewer's denials live in `data.dispositions`.
   * Adding the enum value would mean a migration, a status every reader must
   * newly handle, and a second place the same fact is recorded.
   *
   * That prohibition used to be a COMMENT above the key. A comment asserting a
   * constraint nobody checks is the "comments are not verification" defect
   * class — so it is a gate now. The day someone adds the enum value this
   * fires, and the conversation happens before the fork does, not after.
   *
   * The column's own values are read LIVE off the Drizzle definition
   * (`proposals.status.enumValues`) rather than re-listed here, so this test
   * cannot drift from the DB.
   */
  const columnValues = (
    proposals.status as unknown as { enumValues?: readonly string[] }
  ).enumValues;

  it("reads the column's enum live (self-guard: never assert against nothing)", () => {
    // Without this, a drizzle change making `enumValues` undefined would let
    // the assertions below pass VACUOUSLY — not-a-member-of-nothing is
    // trivially true. Same self-guard idiom as declared-enum-covers-column.
    expect(Array.isArray(columnValues)).toBe(true);
    expect(columnValues!.length).toBeGreaterThan(5);
    expect(columnValues).toContain(ProposalStatus.APPROVED);
  });

  it("`partially_approved` is NOT a value the proposals.status column can hold", () => {
    expect(columnValues).not.toContain("partially_approved");
    expect(Object.values(ProposalStatus)).not.toContain("partially_approved");
  });

  it("still resolves to a distinct human label", () => {
    expect(resolveStatusLabel("partially_approved")).toBe("Partially approved");
    expect(resolveStatusLabel("partially_approved")).not.toBe(
      resolveStatusLabel(ProposalStatus.APPROVED)
    );
  });

  it("adding a non-column key did not disturb the humanizeToken fallback", () => {
    // Every resolver falls back to `humanizeToken`, so a new DB enum value can
    // never reach a user as a raw token. Adding a key that is NOT a column
    // value must not have changed that.
    expect(resolveStatusLabel("some_future_state")).toBe(
      humanizeToken("some_future_state")
    );
    expect(resolveStatusLabel("some_future_state")).not.toBe(
      "some_future_state"
    );
    // And every value the column CAN hold still has a real label, not a
    // humanized fallback of itself.
    for (const value of columnValues!) {
      expect(resolveStatusLabel(value)).toBeTruthy();
    }
  });
});
