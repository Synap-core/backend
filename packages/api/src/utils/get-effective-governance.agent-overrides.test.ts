/**
 * getEffectiveGovernance — agent-principal rules are VISIBLE, and SEPARATE.
 *
 * WHY (diagnosed live, 2026-08-15): this display read only ever reported
 * `principal_kind = "any"` rules. An agent-scoped `verdict:"auto"` rule
 * resolving at rung 2.8 (above rung 8's DEFAULT_AUTO_APPROVE) was ENFORCED —
 * auto-approving `profile.create` — while `synap_governance` truthfully
 * reported an `effective.autoApproveFor` that EXCLUDED it. Honest-but-incomplete
 * in exactly the way that makes per-agent drift invisible.
 *
 * These tests DRIVE the code path (they call the function against a fake db),
 * they do not assert on source text. Each one bites: see the "bite proof"
 * comment on each case for the mutation that turns it red.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── fake db ───────────────────────────────────────────────────────────────
// A queue of query RESULTS consumed in call order. `getEffectiveGovernance`
// issues, in this fixed order:
//   1. workspaces row      (`.where(...).limit(1)`)
//   2. governance_rules    (`.where(...)` awaited directly — the "any" baseline)
//   3. governance_rules    (`.where(...)` awaited — agent overrides)
//   4. users               (`.where(inArray(...))` awaited — agent labels)
// The `.where()` result is BOTH awaitable and `.limit()`-able so one fake
// serves every call shape. Mirrors the fake in
// `packages/database/src/utils/resolve-agent-governance-decision.test.ts`.
const h = vi.hoisted(() => ({
  queue: [] as unknown[][],
}));

vi.mock("@synap/database", async () => {
  const drizzle =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  // The REAL provenance classifier — mocking it would make the provenance
  // assertions below tautological.
  const provenance = await vi.importActual<
    typeof import("@synap/database/governance-rule-provenance")
  >("@synap/database/governance-rule-provenance");
  const makeWhereResult = () => {
    const rows = h.queue.shift() ?? [];
    return {
      limit: async () => rows,
      then: (resolve: (rows: unknown[]) => void) => resolve(rows),
    };
  };
  return {
    ...provenance,
    and: drizzle.and,
    or: drizzle.or,
    eq: drizzle.eq,
    gt: drizzle.gt,
    gte: drizzle.gte,
    isNull: drizzle.isNull,
    isNotNull: drizzle.isNotNull,
    desc: drizzle.desc,
    inArray: drizzle.inArray,
    drizzleSql: drizzle.sql,
    db: {
      select: () => ({ from: () => ({ where: makeWhereResult }) }),
      query: {},
    },
    proposals: {},
    entities: {},
    ProfileResolutionService: class {},
    insertPendingProposal: vi.fn(),
    findExistingPendingDuplicate: vi.fn(),
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(),
  resolveGovernanceRule: vi.fn(),
}));

vi.mock("@synap/jobs", () => ({ broadcastNotification: vi.fn() }));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: class {},
}));
vi.mock("../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(),
}));

import { getEffectiveGovernance } from "./permission-check.js";
import { DEFAULT_AUTO_APPROVE } from "@synap/governance-policy";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "agent-user-1";

/**
 * A `governance_rules` row as BOTH reads select it. The same mixed set is
 * handed to the baseline query AND the agent-override query — so the
 * separation the tests assert must come from the code's own principal
 * discrimination, not from the (unexercised) SQL WHERE. A fake db cannot
 * evaluate a real drizzle predicate; feeding both queries the same mixed set
 * is what makes these tests bite instead of tautologically pass.
 */
function ruleRow(o: {
  id: string;
  principalKind: "any" | "agent";
  agentUserId?: string | null;
  targetPattern: string;
  verdict: "auto" | "propose";
  createdBy?: string;
  sourceProposalId?: string | null;
  scopeKind?: "pod" | "workspace";
}) {
  return {
    id: o.id,
    principalKind: o.principalKind,
    agentUserId: o.agentUserId ?? null,
    targetKind: "action" as const,
    targetPattern: o.targetPattern,
    targetProfile: null,
    verdict: o.verdict,
    scopeKind: o.scopeKind ?? "pod",
    workspaceId: o.scopeKind === "workspace" ? WS : null,
    createdBy: o.createdBy ?? "user-human-1",
    sourceProposalId: o.sourceProposalId ?? null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    expiresAt: null,
  };
}

/** The exact live drift: an agent-scoped pod-wide auto grant on profile.create. */
const AGENT_AUTO_PROFILE_CREATE = ruleRow({
  id: "rule-agent-auto",
  principalKind: "agent",
  agentUserId: AGENT,
  targetPattern: "profile.create",
  verdict: "auto",
  createdBy: "system:governance-backfill",
});

/** A genuine workspace-wide (any-principal) auto grant. */
const ANY_AUTO_VIEW_CREATE = ruleRow({
  id: "rule-any-auto",
  principalKind: "any",
  targetPattern: "view.create",
  verdict: "auto",
  scopeKind: "workspace",
});

function seed(rules: unknown[], agentUsers: unknown[] = []) {
  h.queue = [
    [{ settings: {} }], // workspaces row
    rules, // baseline query
    rules, // agent-override query (SAME set — see ruleRow docstring)
    agentUsers, // agent-label lookup
  ];
}

beforeEach(() => {
  h.queue = [];
});

describe("getEffectiveGovernance — agentOverrides", () => {
  it("an agent-principal verdict:'auto' rule appears in agentOverrides[] and NOT in autoApproveFor", async () => {
    // BITE PROOF: drop the `anyPrincipalRows` filter in permission-check.ts
    // (the pre-fix behaviour of merging whatever the query returned) and
    // "profile.create" leaks into autoApproveFor → the second expect fails.
    seed(
      [AGENT_AUTO_PROFILE_CREATE],
      [{ id: AGENT, name: "Eve", agentType: "meta" }]
    );

    const res = await getEffectiveGovernance(WS);

    expect(res.effective.agentOverrides.map((o) => o.targetPattern)).toEqual([
      "profile.create",
    ]);
    expect(res.effective.autoApproveFor).not.toContain("profile.create");
    // …and the baseline is otherwise untouched: still exactly the code floor.
    expect([...res.effective.autoApproveFor].sort()).toEqual(
      [...DEFAULT_AUTO_APPROVE].sort()
    );
  });

  it("a principalKind:'any' rule still appears in autoApproveFor, and NOT in agentOverrides", async () => {
    // BITE PROOF: remove the `principalKind === "agent"` filter in
    // listAgentGovernanceOverrides and the any-principal rule shows up as an
    // "agent override" → the `agentOverrides` expect fails. The second fixture
    // is an any-principal row that ALSO carries a stray non-null
    // `agent_user_id` (the column is nullable and nothing clears it when a rule
    // is authored agent-first then widened to "any") — without it the null
    // check alone masks a missing principal filter, and this test would not
    // bite at all.
    seed(
      [
        ANY_AUTO_VIEW_CREATE,
        ruleRow({
          id: "rule-any-with-stale-agent-id",
          principalKind: "any",
          agentUserId: AGENT,
          targetPattern: "cell.create",
          verdict: "auto",
        }),
      ],
      [{ id: AGENT, name: "Eve", agentType: "meta" }]
    );

    const res = await getEffectiveGovernance(WS);

    expect(res.effective.autoApproveFor).toContain("view.create");
    expect(res.effective.autoApproveFor).toContain("cell.create");
    expect(res.effective.agentOverrides).toEqual([]);
    expect(res.source).toBe("rules");
  });

  it("mixed set: each rule lands in exactly one field — no double-counting, no merge", async () => {
    seed(
      [AGENT_AUTO_PROFILE_CREATE, ANY_AUTO_VIEW_CREATE],
      [{ id: AGENT, name: "Eve", agentType: "meta" }]
    );

    const res = await getEffectiveGovernance(WS);

    expect(res.effective.autoApproveFor).toContain("view.create");
    expect(res.effective.autoApproveFor).not.toContain("profile.create");
    expect(res.effective.agentOverrides).toHaveLength(1);
    expect(res.effective.agentOverrides[0]?.ruleId).toBe("rule-agent-auto");
  });

  it("provenance survives to the caller: machine-minted vs earned vs authored vs unknown", async () => {
    // BITE PROOF: drop `createdBy`/`sourceProposalId` from the select or the
    // DTO and every assertion below fails — this is the whole diagnostic value
    // (a backfilled grant NOBODY reviewed vs an approved widening).
    seed(
      [
        AGENT_AUTO_PROFILE_CREATE,
        ruleRow({
          id: "rule-agent-earned",
          principalKind: "agent",
          agentUserId: AGENT,
          targetPattern: "entity.update",
          verdict: "auto",
          createdBy: "user-human-1",
          sourceProposalId: "22222222-2222-4222-8222-222222222222",
        }),
        ruleRow({
          id: "rule-agent-authored",
          principalKind: "agent",
          agentUserId: AGENT,
          targetPattern: "doc.create",
          verdict: "propose",
          // The Rules editor's stamp (`authoredCreatedBy(ctx.userId)`).
          createdBy: "user:user-human-1",
        }),
        // The MIRROR's stamp — `syncAutoApproveRules` applied to the SAME human
        // id. Before the provenance fix this was byte-identical to the row
        // above and reported "authored".
        ruleRow({
          id: "rule-agent-mirrored",
          principalKind: "agent",
          agentUserId: AGENT,
          targetPattern: "profile.update",
          verdict: "auto",
          createdBy: "system:settings-mirror:user-human-1",
        }),
        // A LEGACY row: bare user id, no marker. Genuinely unknowable.
        ruleRow({
          id: "rule-agent-legacy",
          principalKind: "agent",
          agentUserId: AGENT,
          targetPattern: "skill.create",
          verdict: "auto",
          createdBy: "user-human-1",
        }),
      ],
      [{ id: AGENT, name: "Eve", agentType: "meta" }]
    );

    const res = await getEffectiveGovernance(WS);
    const byId = new Map(
      res.effective.agentOverrides.map((o) => [o.ruleId, o])
    );

    expect(byId.get("rule-agent-auto")).toMatchObject({
      createdBy: "system:governance-backfill",
      sourceProposalId: null,
      provenance: "machine",
      verdict: "auto",
      scopeKind: "pod",
    });
    expect(byId.get("rule-agent-earned")).toMatchObject({
      sourceProposalId: "22222222-2222-4222-8222-222222222222",
      provenance: "earned",
    });
    expect(byId.get("rule-agent-authored")).toMatchObject({
      createdBy: "user:user-human-1",
      sourceProposalId: null,
      provenance: "authored",
      verdict: "propose",
    });
    // 🔴 THE FALSE-ASSURANCE CASE: a row the MIRROR minted under the human's
    // id must NOT read as "the human authored this".
    expect(byId.get("rule-agent-mirrored")).toMatchObject({
      createdBy: "system:settings-mirror:user-human-1",
      sourceProposalId: null,
      provenance: "machine",
    });
    expect(byId.get("rule-agent-mirrored")?.provenance).not.toBe("authored");
    // Fail toward suspicion: an unmarked legacy author is "unknown", not a
    // manufactured claim of deliberate authorship.
    expect(byId.get("rule-agent-legacy")).toMatchObject({
      createdBy: "user-human-1",
      provenance: "unknown",
    });
  });

  it("resolves the agent's display label, falling back to the id when the user row is missing", async () => {
    // BITE PROOF: an entry with no label is uninspectable — a bare uuid tells
    // an operator nothing about WHICH agent was widened.
    seed(
      [
        AGENT_AUTO_PROFILE_CREATE,
        ruleRow({
          id: "rule-agent-orphan",
          principalKind: "agent",
          agentUserId: "agent-gone",
          targetPattern: "entity.create",
          verdict: "auto",
        }),
      ],
      [{ id: AGENT, name: "Eve", agentType: "meta" }]
    );

    const res = await getEffectiveGovernance(WS);
    const byId = new Map(
      res.effective.agentOverrides.map((o) => [o.ruleId, o])
    );

    expect(byId.get("rule-agent-auto")?.agentLabel).toBe("Eve");
    expect(byId.get("rule-agent-orphan")?.agentLabel).toBe("agent-gone");
  });

  it("an agent-principal row with a NULL agentUserId is dropped (it can match no principal at enforcement)", async () => {
    seed([
      ruleRow({
        id: "rule-agent-nullprincipal",
        principalKind: "agent",
        agentUserId: null,
        targetPattern: "entity.delete",
        verdict: "auto",
      }),
    ]);

    const res = await getEffectiveGovernance(WS);

    expect(res.effective.agentOverrides).toEqual([]);
    expect(res.effective.autoApproveFor).not.toContain("entity.delete");
  });

  it("no rules at all → agentOverrides is empty and the baseline is the code floor", async () => {
    seed([]);

    const res = await getEffectiveGovernance(WS);

    expect(res.effective.agentOverrides).toEqual([]);
    expect(res.source).toBe("default");
    expect([...res.effective.autoApproveFor].sort()).toEqual(
      [...DEFAULT_AUTO_APPROVE].sort()
    );
  });
});
