import { describe, it, expect } from "vitest";
import {
  draftRuleMatchesWrite,
  resolveGovernanceRule,
} from "./resolve-agent-governance-decision.js";

/**
 * The trust ladder's NARROWEST grant (`nextRungRuleDraft`,
 * `@synap-core/types/trust-ladder`) is an ACTION rule that also names a
 * profile: agent × action × profile. Two properties make it a real grant and
 * not a label:
 *   1. it matches ONLY that action on that profile (never the same action on
 *      another kind, never a write the gate saw no profile for);
 *   2. it OUTRANKS a broader propose rule at the same principal/scope — a
 *      posture's agent × exact-action `propose` row — or the offer would store a
 *      rule that never fires.
 * Fake db: the candidate rows are returned as if the SQL had already filtered
 * principal/scope (same convention as resolve-agent-governance-decision.test.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dbReturning(rows: unknown[]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (r: unknown[]) => void) => resolve(rows),
        }),
      }),
    }),
  };
}

const row = (o: {
  id: string;
  targetPattern: string;
  targetProfile?: string | null;
  verdict: "auto" | "propose";
  targetKind?: "action" | "profile";
  createdAt?: Date;
}) => ({
  id: o.id,
  principalKind: "agent" as const,
  scopeKind: "pod" as const,
  targetKind: o.targetKind ?? ("action" as const),
  targetPattern: o.targetPattern,
  targetProfile: o.targetProfile ?? null,
  verdict: o.verdict,
  createdAt: o.createdAt ?? new Date("2026-09-01T00:00:00Z"),
});

const DRAFT = {
  principalKind: "agent" as const,
  agentUserId: "agent-1",
  scopeKind: "pod" as const,
  targetKind: "action" as const,
  targetPattern: "entity.update",
  targetProfile: "note",
  verdict: "auto" as const,
};

describe("action × profile rule", () => {
  it("matches that action on that profile only", () => {
    const write = {
      subjectType: "entity",
      action: "update",
      agentUserId: "agent-1",
    };
    expect(draftRuleMatchesWrite(DRAFT, { ...write, profileSlug: "note" })).toBe(
      true
    );
    expect(
      draftRuleMatchesWrite(DRAFT, { ...write, profileSlug: "person" })
    ).toBe(false);
    expect(draftRuleMatchesWrite(DRAFT, { ...write, profileSlug: null })).toBe(
      false
    );
    expect(
      draftRuleMatchesWrite(DRAFT, {
        ...write,
        action: "create",
        profileSlug: "note",
      })
    ).toBe(false);
  });

  it("outranks an OLDER-or-newer agent × exact-action propose rule (a posture)", async () => {
    const posture = row({
      id: "posture",
      targetPattern: "entity.update",
      verdict: "propose",
      // Newer than the grant: specificity must win, not recency.
      createdAt: new Date("2026-09-20T00:00:00Z"),
    });
    const grant = row({
      id: "grant",
      targetPattern: "entity.update",
      targetProfile: "note",
      verdict: "auto",
    });
    const match = await resolveGovernanceRule({
      db: dbReturning([posture, grant]),
      agentUserId: "agent-1",
      subjectType: "entity",
      action: "update",
      profileSlug: "note",
    });
    expect(match?.ruleId).toBe("grant");
    expect(match?.verdict).toBe("auto");
  });

  it("leaves the posture in charge of every other profile", async () => {
    const posture = row({
      id: "posture",
      targetPattern: "entity.update",
      verdict: "propose",
    });
    const grant = row({
      id: "grant",
      targetPattern: "entity.update",
      targetProfile: "note",
      verdict: "auto",
    });
    const match = await resolveGovernanceRule({
      db: dbReturning([posture, grant]),
      agentUserId: "agent-1",
      subjectType: "entity",
      action: "update",
      profileSlug: "person",
    });
    expect(match?.ruleId).toBe("posture");
    expect(match?.verdict).toBe("propose");
  });

  it("an action rule with no profile still matches every profile (unchanged)", () => {
    const { targetProfile: _p, ...bare } = DRAFT;
    expect(
      draftRuleMatchesWrite(bare, {
        subjectType: "entity",
        action: "update",
        agentUserId: "agent-1",
        profileSlug: "person",
      })
    ).toBe(true);
  });
});
