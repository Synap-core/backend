/**
 * TRIPWIRE — a `targetProfile` on an ACTION rule may only NARROW (team-lead,
 * W7, 2026-09-28). The trust ladder's grant is agent × action × PROFILE; the
 * profile is allowed to make the rule match FEWER writes and to outrank
 * broader rules at rung 2.8 — never to match MORE, and never to reach above
 * rung 2.8 (below a floor).
 *
 *  1. SUBSET: over a derived grid of (event key × profile), every write a
 *     profile-scoped rule matches, the same rule WITHOUT the profile also
 *     matches — and it never matches another profile, nor a write the gate
 *     saw no profile for. Uses `draftRuleMatchesWrite`, the SAME scorer
 *     rung 2.8 ranks with.
 *  1b. NEVER LOOSENS: a profile on a NON-exact pattern (`entity.*`, `*`) is
 *     IGNORED — the rule matches exactly what it matched before profiles
 *     narrowed anything — because narrowing a broad `propose` rule would let a
 *     broader `auto` rule execute. Checked for match-sets AND for a live
 *     `propose` rule against a broader `auto` one.
 *  1c. NEVER STRONGER: an exact auto rule with a profile scores the same as a
 *     plain exact rule, so a NEWER `propose` of equal specificity always wins.
 *  2. BELOW EVERY FLOOR: for every event-keyed floor (derived from the
 *     engine's own lists) and every context floor, a profile-scoped `auto`
 *     rule that WINS `resolveGovernanceRule` still leaves `decideAgentPolicy`
 *     at propose.
 *
 * NOT covered: the SQL principal/scope filter (fake db, as the sibling
 * resolver suite); floors keyed on something other than the event key or the
 * five context flags below would not be in the scanned set.
 */
import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS,
  AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  ARBITRARY_EXECUTION_EVENT_KEYS,
  DESTRUCTIVE_ACTIONS,
  HUMAN_GATE_EVENT_KEYS,
  REVERSIBLE_EVENT_KEYS,
  decideAgentPolicy,
  type AgentPolicyInput,
} from "@synap/governance-policy";
import {
  draftRuleMatchesWrite,
  resolveGovernanceRule,
} from "./resolve-agent-governance-decision.js";

const PROFILES = ["note", "person", "company"];
const AGENT = "agent-1";

const split = (key: string) => {
  const dot = key.lastIndexOf(".");
  return { subjectType: key.slice(0, dot), action: key.slice(dot + 1) };
};

const profileRule = (key: string, profile: string) => ({
  principalKind: "agent" as const,
  agentUserId: AGENT,
  scopeKind: "pod" as const,
  targetKind: "action" as const,
  targetPattern: key,
  targetProfile: profile,
  verdict: "auto" as const,
});

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

const FLOORED_KEYS = [
  ...ADMIN_ACTIONS.filter((k) => k.includes(".")),
  ...HUMAN_GATE_EVENT_KEYS,
  ...ARBITRARY_EXECUTION_EVENT_KEYS,
  ...AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  ...AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  ...DESTRUCTIVE_ACTIONS.map((v) => `entity.${v}`),
];

const CONTEXT_FLOORS: Array<Partial<AgentPolicyInput>> = [
  { forcePropose: true },
  { originTrust: "untrusted" },
  { ceilingVerdict: "propose" },
  { podAdminSchemaChange: true },
  { subjectProfileSlug: "user_observation" },
];

describe("a profile on an action rule only narrows", () => {
  it("non-vacuity: the grids are the engine's size and include known keys", () => {
    expect(REVERSIBLE_EVENT_KEYS.length).toBeGreaterThan(10);
    expect(REVERSIBLE_EVENT_KEYS).toContain("entity.update");
    expect(FLOORED_KEYS.length).toBeGreaterThan(10);
    expect(FLOORED_KEYS).toContain("entity.delete");
  });

  it("SUBSET: it matches only writes the bare action rule matches, on its own profile", () => {
    let matched = 0;
    for (const key of [...REVERSIBLE_EVENT_KEYS, ...FLOORED_KEYS]) {
      for (const ruleProfile of PROFILES) {
        const narrow = profileRule(key, ruleProfile);
        const { targetProfile: _p, ...bare } = narrow;
        for (const writeKey of [key, "entity.update", "document.update"]) {
          for (const writeProfile of [...PROFILES, null]) {
            const write = {
              ...split(writeKey),
              agentUserId: AGENT,
              profileSlug: writeProfile,
            };
            if (!draftRuleMatchesWrite(narrow, write)) continue;
            matched++;
            expect(draftRuleMatchesWrite(bare, write), `${key}/${ruleProfile}`).toBe(true);
            expect(writeProfile, `${key}/${ruleProfile}`).toBe(ruleProfile);
          }
        }
      }
    }
    expect(matched).toBeGreaterThan(50);
  });

  it("NEVER LOOSENS: a profile on a non-exact pattern changes nothing (auto and propose)", () => {
    let compared = 0;
    for (const pattern of ["entity.*", "document.*", "*"]) {
      for (const verdict of ["auto", "propose"] as const) {
        for (const ruleProfile of PROFILES) {
          const narrow = { ...profileRule(pattern, ruleProfile), verdict };
          const { targetProfile: _p, ...bare } = narrow;
          for (const writeKey of [...REVERSIBLE_EVENT_KEYS, ...FLOORED_KEYS]) {
            for (const writeProfile of [...PROFILES, null]) {
              const write = { ...split(writeKey), agentUserId: AGENT, profileSlug: writeProfile };
              expect(
                draftRuleMatchesWrite(narrow, write),
                `${pattern}/${ruleProfile} on ${writeKey}/${writeProfile}`
              ).toBe(draftRuleMatchesWrite(bare, write));
              compared++;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it("NEVER LOOSENS, live: a broad propose rule with a profile still beats a broader auto rule on EVERY kind", async () => {
    for (const writeProfile of [...PROFILES, "deal"]) {
      const match = await resolveGovernanceRule({
        db: dbReturning([
          { id: "tighten", principalKind: "agent", scopeKind: "pod", targetKind: "action", targetPattern: "entity.*", targetProfile: "person", verdict: "propose", createdAt: new Date("2026-09-01") },
          { id: "broad-auto", principalKind: "any", scopeKind: "pod", targetKind: "action", targetPattern: "*", targetProfile: null, verdict: "auto", createdAt: new Date("2026-09-20") },
        ]),
        agentUserId: AGENT,
        subjectType: "entity",
        action: "update",
        profileSlug: writeProfile,
      });
      expect(match?.ruleId, writeProfile).toBe("tighten");
    }
  });

  it("NEVER STRONGER: a newer propose of equal specificity beats an older profile-scoped auto", async () => {
    for (const key of REVERSIBLE_EVENT_KEYS) {
      const { subjectType, action } = split(key);
      const match = await resolveGovernanceRule({
        db: dbReturning([
          { id: "old-grant", principalKind: "agent", scopeKind: "pod", targetKind: "action", targetPattern: key, targetProfile: "note", verdict: "auto", createdAt: new Date("2026-09-01") },
          { id: "new-posture", principalKind: "agent", scopeKind: "pod", targetKind: "action", targetPattern: key, targetProfile: null, verdict: "propose", createdAt: new Date("2026-09-20") },
        ]),
        agentUserId: AGENT,
        subjectType,
        action,
        profileSlug: "note",
      });
      expect(match?.verdict, key).toBe("propose");
    }
  });

  it("BELOW EVERY FLOOR: a winning profile-scoped auto rule never lifts a floor", async () => {
    const cases: Array<{ key: string; context: Partial<AgentPolicyInput> }> = [
      ...FLOORED_KEYS.map((key) => ({ key, context: {} })),
      ...CONTEXT_FLOORS.map((context) => ({ key: "entity.update", context })),
    ];
    for (const { key, context } of cases) {
      const { subjectType, action } = split(key);
      const match = await resolveGovernanceRule({
        db: dbReturning([
          {
            id: "grant",
            principalKind: "agent",
            scopeKind: "pod",
            targetKind: "action",
            targetPattern: key,
            targetProfile: "note",
            verdict: "auto",
            createdAt: new Date(),
          },
        ]),
        agentUserId: AGENT,
        subjectType,
        action,
        profileSlug: "note",
      });
      // The rule DOES win rung 2.8 — the floor above it must still hold.
      expect(match?.ruleId, key).toBe("grant");
      const verdict = decideAgentPolicy({
        subjectType,
        action,
        governanceRuleVerdict: match!.verdict,
        ...context,
      });
      expect(verdict.verdict, `${key} ${JSON.stringify(context)}`).toBe("propose");
    }
  });
});
