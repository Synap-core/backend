import { describe, it, expect } from "vitest";
import { resolveGovernanceRule } from "./resolve-agent-governance-decision.js";

/**
 * A rule that NAMES one object (0420, founder decision of 10 Nov 2026: "let
 * agents run this playbook without asking", pinned to its version) may only
 * NARROW: it matches the exact action on that object at that version, for an
 * agent of the person who made it, and nothing else. A broad rule never reads
 * as naming the object. The plain match, the next version, another playbook
 * and no subject are driven on PGlite
 * (`resolve-agent-governance-decision.subject.pglite.test.ts`).
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
const PERSON = "33333333-3333-4333-8333-333333333333";
const OTHER_PERSON = "44444444-4444-4444-8444-444444444444";

const row = (o: {
  id: string;
  targetPattern: string;
  verdict: "auto" | "propose";
  targetSubjectId?: string | null;
  targetSubjectVersion?: number | null;
  principalOwnerId?: string | null;
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
  principalOwnerId:
    o.principalOwnerId !== undefined
      ? o.principalOwnerId
      : o.targetSubjectId
        ? PERSON
        : null,
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
  ruleSubject?: { id: string; version: number; forUserId: string }
) =>
  resolveGovernanceRule({
    db: dbReturning(rows),
    agentUserId: "agent-1",
    subjectType: "playbook",
    action: "run",
    ...(ruleSubject ? { ruleSubject } : {}),
  });

describe("a rule naming one playbook at one version", () => {
  it("matches an agent of the person who made it, never another person's agent", async () => {
    const run = { id: P, version: 3 };
    expect(
      await resolveRun([PRE_APPROVAL], { ...run, forUserId: PERSON })
    ).toMatchObject({ ruleId: "pre", namesSubject: true });
    expect(
      await resolveRun([PRE_APPROVAL], { ...run, forUserId: OTHER_PERSON })
    ).toBeUndefined();
    const ownerless = row({
      id: "ownerless",
      targetPattern: "playbook.run",
      verdict: "auto",
      targetSubjectId: P,
      targetSubjectVersion: 3,
      principalOwnerId: null,
    });
    expect(
      await resolveRun([ownerless], { ...run, forUserId: PERSON })
    ).toBeUndefined();
  });

  it("matches nothing on another action, or under a glob pattern", async () => {
    const onUpdate = await resolveGovernanceRule({
      db: dbReturning([PRE_APPROVAL]),
      agentUserId: "agent-1",
      subjectType: "playbook",
      action: "update",
      ruleSubject: { id: P, version: 3, forUserId: PERSON },
    });
    expect(onUpdate).toBeUndefined();
    const glob = row({
      id: "glob",
      targetPattern: "playbook.*",
      verdict: "auto",
      targetSubjectId: P,
      targetSubjectVersion: 3,
    });
    expect(
      await resolveRun([glob], { id: P, version: 3, forUserId: PERSON })
    ).toBeUndefined();
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
    const viaBroad = await resolveRun([broad], {
      id: P,
      version: 3,
      forUserId: PERSON,
    });
    expect(viaBroad).toMatchObject({ ruleId: "broad" });
    expect(viaBroad).not.toHaveProperty("namesSubject");
    const viaExact = await resolveRun([exact], {
      id: P,
      version: 3,
      forUserId: PERSON,
    });
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
      await resolveRun([broadPropose, PRE_APPROVAL], {
        id: P,
        version: 3,
        forUserId: PERSON,
      })
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
      forUserId: PERSON,
    });
    expect(later).toMatchObject({ ruleId: "later" });
    expect(later).not.toHaveProperty("namesSubject");
  });
});
