import { describe, it, expect } from "vitest";
import { resolveGovernanceRule } from "./resolve-agent-governance-decision.js";

/**
 * A rule that NAMES one object (0420, founder decision of 10 Nov 2026: "let
 * agents run this playbook without asking", pinned to its version) may only
 * NARROW: it matches the exact action on that object at that version, and
 * nothing else. A broad rule never reads as naming the object.
 * Fake db: candidate rows come back as if the SQL had already filtered
 * principal and scope (convention of resolve-agent-governance-decision.test.ts).
 */

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

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";

const row = (o: {
  id: string;
  targetPattern: string;
  verdict: "auto" | "propose";
  targetSubjectId?: string | null;
  targetSubjectVersion?: number | null;
  createdAt?: Date;
}) => ({
  id: o.id,
  principalKind: "any" as const,
  scopeKind: "pod" as const,
  targetKind: "action" as const,
  targetPattern: o.targetPattern,
  targetProfile: null,
  targetSubjectId: o.targetSubjectId ?? null,
  targetSubjectVersion: o.targetSubjectVersion ?? null,
  verdict: o.verdict,
  createdAt: o.createdAt ?? new Date("2026-11-10T00:00:00Z"),
});

const PRE_APPROVAL = row({
  id: "pre",
  targetPattern: "playbook.run",
  verdict: "auto",
  targetSubjectId: P,
  targetSubjectVersion: 3,
});

const resolveRun = (
  rows: unknown[],
  ruleSubject?: { id: string; version: number }
) =>
  resolveGovernanceRule({
    db: dbReturning(rows),
    agentUserId: "agent-1",
    subjectType: "playbook",
    action: "run",
    ...(ruleSubject ? { ruleSubject } : {}),
  });

describe("a rule naming one playbook at one version", () => {
  it("matches a run of that playbook at that version, and says it names it", async () => {
    const match = await resolveRun([PRE_APPROVAL], { id: P, version: 3 });
    expect(match).toMatchObject({
      ruleId: "pre",
      verdict: "auto",
      namesSubject: true,
    });
  });

  it("matches nothing once the playbook's version moved on", async () => {
    expect(
      await resolveRun([PRE_APPROVAL], { id: P, version: 4 })
    ).toBeUndefined();
  });

  it("matches nothing for another playbook", async () => {
    expect(
      await resolveRun([PRE_APPROVAL], { id: Q, version: 3 })
    ).toBeUndefined();
  });

  it("matches nothing when the door names no subject", async () => {
    expect(await resolveRun([PRE_APPROVAL])).toBeUndefined();
  });

  it("matches nothing on another action, or under a glob pattern", async () => {
    const onUpdate = await resolveGovernanceRule({
      db: dbReturning([PRE_APPROVAL]),
      agentUserId: "agent-1",
      subjectType: "playbook",
      action: "update",
      ruleSubject: { id: P, version: 3 },
    });
    expect(onUpdate).toBeUndefined();
    const glob = row({
      id: "glob",
      targetPattern: "playbook.*",
      verdict: "auto",
      targetSubjectId: P,
      targetSubjectVersion: 3,
    });
    expect(await resolveRun([glob], { id: P, version: 3 })).toBeUndefined();
  });

  it("a broad auto rule still matches, but never reads as naming the playbook", async () => {
    const broad = row({
      id: "broad",
      targetPattern: "playbook.*",
      verdict: "auto",
    });
    const exact = row({
      id: "exact",
      targetPattern: "playbook.run",
      verdict: "auto",
    });
    const viaBroad = await resolveRun([broad], { id: P, version: 3 });
    expect(viaBroad).toMatchObject({ ruleId: "broad" });
    expect(viaBroad).not.toHaveProperty("namesSubject");
    const viaExact = await resolveRun([exact], { id: P, version: 3 });
    expect(viaExact).toMatchObject({ ruleId: "exact" });
    expect(viaExact).not.toHaveProperty("namesSubject");
  });

  it("outranks a broad rule, and a newer exact propose of equal reach takes it back", async () => {
    const broadPropose = row({
      id: "broad",
      targetPattern: "*",
      verdict: "propose",
    });
    expect(
      await resolveRun([broadPropose, PRE_APPROVAL], { id: P, version: 3 })
    ).toMatchObject({ ruleId: "pre", namesSubject: true });
    const laterPropose = row({
      id: "later",
      targetPattern: "playbook.run",
      verdict: "propose",
      createdAt: new Date("2026-11-11T00:00:00Z"),
    });
    const later = await resolveRun([PRE_APPROVAL, laterPropose], {
      id: P,
      version: 3,
    });
    expect(later).toMatchObject({ ruleId: "later" });
    expect(later).not.toHaveProperty("namesSubject");
  });
});
