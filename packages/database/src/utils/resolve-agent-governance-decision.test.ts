import { describe, it, expect } from "vitest";
import {
  dryRunAgentGovernanceDecision,
  resolveAgentGovernanceDecision,
  resolveGovernanceRule,
  resolveOriginTrust,
} from "./resolve-agent-governance-decision.js";
import { ChannelType } from "../schema/channels.js";
import { runWithHeldWritesApproved } from "./request-write-context.js";

/**
 * Minimal fake db: a queue of query RESULTS, consumed in call order.
 * `resolveAgentGovernanceDecision` issues queries in this fixed order:
 *   1. `users` row (`.limit(1)` chain)
 *   2. `workspaces` row, ONLY when `workspaceId` is set (`.limit(1)` chain)
 *   3. `governance_rules` candidate rows (rung 2.8's I/O half — NO `.limit()`,
 *      the query is awaited directly)
 *
 * The returned `.where()` result is made BOTH awaitable (via `.then`, so a
 * bare `await db...where(...)` resolves straight to the queued rows — what
 * `resolveGovernanceRule` does) AND `.limit()`-able (what the users/workspace
 * lookups do) so the same fake db serves every call shape in the ladder.
 *
 * This is a "given these fetched rows, does the resolver + pure engine
 * combine them correctly" unit test — it does NOT exercise the real SQL
 * WHERE predicates (principal/scope filtering), which requires a live DB
 * (blocked in this environment; see packages/database's live-PG test
 * baseline). Each governance_rules fixture below is written as if the real
 * WHERE clause had ALREADY filtered rows for the (agentUserId, workspaceId,
 * includeAgentPrincipal) tuple in play, mirroring what production SQL does.
 */

function makeDb(resultsQueue: any[][]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = resultsQueue.shift() ?? [];
          return {
            limit: async () => rows,
            then: (resolve: (rows: unknown[]) => void) => resolve(rows),
          };
        },
      }),
    }),
  };
}

const AGENT_ROW = {
  userType: "agent",
  agentMetadata: { autoApproveFor: ["entity.create"] },
};

/** A `governance_rules` candidate row, as `resolveGovernanceRule` selects it. */
function ruleRow(overrides: {
  principalKind: "agent" | "any";
  scopeKind: "workspace" | "pod";
  targetPattern: string;
  verdict: "auto" | "propose";
  targetKind?: "action" | "profile" | "capability";
  targetProfile?: string | null;
  createdAt?: Date;
}) {
  return {
    principalKind: overrides.principalKind,
    scopeKind: overrides.scopeKind,
    targetKind: overrides.targetKind ?? "action",
    targetPattern: overrides.targetPattern,
    targetProfile: overrides.targetProfile ?? null,
    verdict: overrides.verdict,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

describe("dryRunAgentGovernanceDecision", () => {
  it("is side-effect free: never touches db.insert (no such method on the fake db)", async () => {
    const db = makeDb([
      [AGENT_ROW],
      [{ settings: {}, workspaceType: "personal" }],
      [],
    ]);
    // The fake db has no `.insert` — if the dry-run ever reached a write
    // path, this would throw "db.insert is not a function".
    await expect(
      dryRunAgentGovernanceDecision({
        db,
        agentUserId: "agent-1",
        workspaceId: "ws-1",
        subjectType: "entity",
        action: "create",
        door: "chat",
      })
    ).resolves.toBeDefined();
  });

  it("not-agent actor → reports auto with a not-agent rung, never denies", async () => {
    const db = makeDb([[{ userType: "human", agentMetadata: null }]]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "human-1",
      workspaceId: null,
      subjectType: "entity",
      action: "create",
      door: "chat",
    });

    expect(verdict.outcome).toBe("auto");
    expect(verdict.rung).toBe("not-agent");
  });

  it("admin action always proposes regardless of door", async () => {
    const db = makeDb([
      [AGENT_ROW],
      [{ settings: {}, workspaceType: "personal" }],
      [],
    ]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "workspace",
      action: "update",
      door: "automation",
    });

    expect(verdict.outcome).toBe("propose");
    expect(verdict.rung).toBe("admin-actions");
  });

  it("destructive action always proposes, even with a matching auto rule", async () => {
    const db = makeDb([
      [AGENT_ROW],
      [{ settings: {}, workspaceType: "personal" }],
      // Even a rule that would (wrongly) whitelist "entity.delete" can never
      // win — the DESTRUCTIVE_ACTIONS hard floor (rung 2.5) returns BEFORE
      // rung 2.8 is even consulted by the engine.
      [
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "entity.delete",
          verdict: "auto",
        }),
      ],
    ]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "delete",
      door: "automation",
    });

    expect(verdict.outcome).toBe("propose");
    expect(verdict.rung).toBe("destructive-actions-hard-floor");
  });
});

/**
 * ONE-STORE (Phase B): the engine no longer reads `autoApproveFor` from the
 * workspace/agent JSONB directly — `governance_rules` (rung 2.8) is the only
 * additive auto-approve signal above the DEFAULT_AUTO_APPROVE code floor
 * (rung 8). These tests exercise `resolveAgentGovernanceDecision` (not just
 * the dry-run) directly, proving:
 *   1. A rule BACKFILLED from a workspace's old JSONB list produces the SAME
 *      "execute" verdict the JSONB used to (backfill parity).
 *   2. The chat door consults agent-scoped rules; the automation door does
 *      not (mirrors the pre-existing `preferAgentMetadataAutoApproveFor`
 *      precedence, now expressed as `includeAgentPrincipal`).
 */
describe("resolveAgentGovernanceDecision — one-store (governance_rules)", () => {
  it('BACKFILL PARITY: a workspace whose JSONB had ["entity.create"] still auto-approves entity.create once backfilled into governance_rules', async () => {
    const db = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      // Workspace JSONB override is now ABSENT (Phase C would eventually
      // stop writing it; here we prove the ENGINE no longer needs it even
      // if it's still present) — only the backfilled rule matters.
      [{ settings: {}, workspaceType: "personal" }],
      [
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "entity.create",
          verdict: "auto",
        }),
      ],
    ]);

    const result = await resolveAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      preferAgentMetadataAutoApproveFor: true,
    });

    expect(result.decision).toBe("execute");
  });

  it("a governance_rule can override rung 8's default-auto-approve with a PROPOSE verdict", async () => {
    // entity.create IS in DEFAULT_AUTO_APPROVE (rung 8) — absent any rule,
    // this would auto-execute. A "propose" rule for the exact same event key
    // sits at rung 2.8, ABOVE rung 8, so it wins instead.
    const db = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "entity.create",
          verdict: "propose",
        }),
      ],
    ]);

    const result = await resolveAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      preferAgentMetadataAutoApproveFor: true,
    });

    expect(result.decision).toBe("propose");
  });

  it("automation door ignores an agent-scoped rule; chat door consults it (includeAgentPrincipal parity)", async () => {
    // "custom_capability.run" is in neither DEFAULT_AUTO_APPROVE, ADMIN_ACTIONS,
    // nor DESTRUCTIVE_ACTIONS — absent a matching rule, it always proposes
    // (rung 9 default), so a rule flipping it to "execute" is unambiguous
    // proof the rule was consulted (not just DEFAULT_AUTO_APPROVE coincidence).
    const agentScopedRule = ruleRow({
      principalKind: "agent",
      scopeKind: "pod",
      targetPattern: "custom_capability.run",
      verdict: "auto",
    });

    // CHAT DOOR (preferAgentMetadataAutoApproveFor: true → includeAgentPrincipal:
    // true): the agent-scoped rule is in the candidate set the (mocked) SQL
    // already filtered for this door → executes.
    const chatDb = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [agentScopedRule],
    ]);
    const chatResult = await resolveAgentGovernanceDecision({
      db: chatDb,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "custom_capability",
      action: "run",
      preferAgentMetadataAutoApproveFor: true,
    });
    expect(chatResult.decision).toBe("execute");

    // AUTOMATION DOOR (preferAgentMetadataAutoApproveFor: false →
    // includeAgentPrincipal: false): production SQL never returns an
    // agent-scoped row for this door, so the candidate set is empty here —
    // falls through to the rung 9 default propose.
    const automationDb = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [],
    ]);
    const automationResult = await resolveAgentGovernanceDecision({
      db: automationDb,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "custom_capability",
      action: "run",
      preferAgentMetadataAutoApproveFor: false,
    });
    expect(automationResult.decision).toBe("propose");
  });

  it("resolveGovernanceRule: includeAgentPrincipal=false only requests any-principal rows (automation-door parity)", async () => {
    // Candidate set mixes an agent-scoped AND an any-scoped row for the SAME
    // action. With includeAgentPrincipal=false (automation door), only the
    // "any" row is eligible even though both are in the (mocked) result set —
    // this proves the SCORING excludes agent-principal candidates entirely
    // when the door doesn't request them, not just that agent rows are absent
    // from the SQL result (which the mock can't verify).
    const db = makeDb([
      [
        ruleRow({
          principalKind: "agent",
          scopeKind: "pod",
          targetPattern: "connector.connect",
          verdict: "auto",
        }),
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "connector.connect",
          verdict: "propose",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "connector",
      action: "connect",
      includeAgentPrincipal: false,
    });

    // The any-scoped "propose" row wins — NOT the agent-scoped "auto" row,
    // which would otherwise outrank nothing here (score 0 any-workspace vs
    // 2 agent-pod) if principal exclusion weren't applied. This confirms
    // exclusion, not just a scoring coincidence: absent exclusion the
    // agent-pod row (principal=2, scope=0, target=3 => 5) would outscore the
    // any-workspace row (principal=0, scope=2, target=3 => 5) on a tie... they
    // actually tie at 5, so assert on verdict identity instead of score.
    expect(match?.verdict).toBe("propose");
  });

  it("resolveGovernanceRule: highest specificity wins (exact action > glob > catch-all; workspace > pod)", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "any",
          scopeKind: "pod",
          targetPattern: "*",
          verdict: "propose",
        }),
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "entity.*",
          verdict: "propose",
        }),
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "entity.create",
          verdict: "auto",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      includeAgentPrincipal: false,
    });

    expect(match).toEqual({
      verdict: "auto",
      matchedPattern: "entity.create",
      namesWrite: true,
    });
  });

  it("resolveGovernanceRule: no agentUserId (legacy AI-source path) only matches any-principal rules", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "context.link",
          verdict: "auto",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      // No agentUserId at all — the legacy AI-source path in
      // permission-check.ts (no agent user row) calls this the same way.
      workspaceId: "ws-1",
      subjectType: "context",
      action: "link",
      includeAgentPrincipal: false,
    });

    expect(match).toEqual({
      verdict: "auto",
      matchedPattern: "context.link",
      namesWrite: true,
    });
  });

  it("resolveGovernanceRule: undefined when no candidate matches the event key", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "any",
          scopeKind: "workspace",
          targetPattern: "document.read",
          verdict: "auto",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      includeAgentPrincipal: false,
    });

    expect(match).toBeUndefined();
  });

  it("resolveGovernanceRule: capability rule matches by VERB NAME (reinstall-stable, 2026-07-27)", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "agent",
          scopeKind: "workspace",
          targetKind: "capability",
          // Authored against the stable verb name, NOT the row id — the id
          // changes on every reinstall, the name doesn't.
          targetPattern: "unipile_list_accounts",
          verdict: "auto",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "capability",
      action: "run",
      // A reinstall means the row id no longer matches the rule at all —
      // only the verb name does.
      capabilityId: "skill-id-after-reinstall",
      capabilityVerbName: "unipile_list_accounts",
    });

    expect(match).toEqual({
      verdict: "auto",
      matchedPattern: "unipile_list_accounts",
      namesWrite: true,
    });
  });

  it("resolveGovernanceRule: capability rule still matches by ROW ID (back-compat, pre-existing rules)", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "agent",
          scopeKind: "workspace",
          targetKind: "capability",
          targetPattern: "skill-id-abc",
          verdict: "auto",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "capability",
      action: "run",
      capabilityId: "skill-id-abc",
      capabilityVerbName: "unipile_list_accounts",
    });

    expect(match).toEqual({
      verdict: "auto",
      matchedPattern: "skill-id-abc",
      namesWrite: true,
    });
  });

  it("resolveGovernanceRule: capability rule matching neither id nor verb name → undefined", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "agent",
          scopeKind: "workspace",
          targetKind: "capability",
          targetPattern: "some_other_verb",
          verdict: "auto",
        }),
      ],
    ]);

    const match = await resolveGovernanceRule({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "capability",
      action: "run",
      capabilityId: "skill-id-abc",
      capabilityVerbName: "unipile_list_accounts",
    });

    expect(match).toBeUndefined();
  });
});

/**
 * The outward floor (finding c173cc51): "Everything, always" wrote
 * `any · pod · "*" · auto`, and the capability gate asked this resolver about
 * every capability run, so any agent sent `messaging.external.send` unreviewed.
 * A broad `auto` row is now skipped for a capability run and a capability
 * grant; only a row naming the write may widen it. `messaging://unipile` is the
 * capability id `gateMessagingSend` (external-dispatch.ts) resolves with when no
 * messaging tool row is seeded.
 */
describe("resolveGovernanceRule — the outward floor", () => {
  const SEND = {
    agentUserId: "agent-1",
    workspaceId: "ws-1",
    subjectType: "capability",
    action: "run",
    capabilityId: "messaging://unipile",
    capabilityVerbName: null,
  } as const;
  const EVERYTHING_ALWAYS = ruleRow({
    principalKind: "any",
    scopeKind: "pod",
    targetPattern: "*",
    verdict: "auto",
  });

  it("an 'Everything, always' rule does not authorize an external send", async () => {
    const db = makeDb([[EVERYTHING_ALWAYS]]);
    expect(await resolveGovernanceRule({ db, ...SEND })).toBeUndefined();
  });

  it("neither does a glob or the generic capability.run action: they cover every capability", async () => {
    for (const targetPattern of ["capability.*", "capability.run"]) {
      const db = makeDb([
        [
          ruleRow({
            principalKind: "agent",
            scopeKind: "workspace",
            targetPattern,
            verdict: "auto",
          }),
        ],
      ]);
      expect(await resolveGovernanceRule({ db, ...SEND })).toBeUndefined();
    }
  });

  it("a rule naming that capability still authorizes it", async () => {
    const db = makeDb([
      [
        EVERYTHING_ALWAYS,
        ruleRow({
          principalKind: "any",
          scopeKind: "pod",
          targetKind: "capability",
          targetPattern: "messaging://unipile",
          verdict: "auto",
        }),
      ],
    ]);
    expect(await resolveGovernanceRule({ db, ...SEND })).toEqual({
      verdict: "auto",
      matchedPattern: "messaging://unipile",
      namesWrite: true,
    });
  });

  it("a broad auto that outranks the naming rule is skipped, not ranked", async () => {
    // agent × workspace × "*" scores 4, any × pod × capability scores 3.
    const db = makeDb([
      [
        ruleRow({
          principalKind: "agent",
          scopeKind: "workspace",
          targetPattern: "*",
          verdict: "auto",
        }),
        ruleRow({
          principalKind: "any",
          scopeKind: "pod",
          targetKind: "capability",
          targetPattern: "messaging://unipile",
          verdict: "auto",
        }),
      ],
    ]);
    expect(await resolveGovernanceRule({ db, ...SEND })).toMatchObject({
      verdict: "auto",
      matchedPattern: "messaging://unipile",
    });
  });

  it("a broad propose rule still tightens a naming auto rule it outranks", async () => {
    const db = makeDb([
      [
        ruleRow({
          principalKind: "agent",
          scopeKind: "workspace",
          targetPattern: "*",
          verdict: "propose",
        }),
        ruleRow({
          principalKind: "any",
          scopeKind: "pod",
          targetKind: "capability",
          targetPattern: "messaging://unipile",
          verdict: "auto",
        }),
      ],
    ]);
    expect(await resolveGovernanceRule({ db, ...SEND })).toMatchObject({
      verdict: "propose",
      matchedPattern: "*",
    });
  });

  it("a broad auto never grants a session a capability; the exact action does", async () => {
    const GRANT = {
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "focus_session",
      action: "grant_capability",
    } as const;
    expect(
      await resolveGovernanceRule({
        db: makeDb([[EVERYTHING_ALWAYS]]),
        ...GRANT,
      })
    ).toBeUndefined();
    const exact = ruleRow({
      principalKind: "any",
      scopeKind: "pod",
      targetPattern: "focus_session.grant_capability",
      verdict: "auto",
    });
    expect(
      await resolveGovernanceRule({ db: makeDb([[exact]]), ...GRANT })
    ).toMatchObject({ verdict: "auto", namesWrite: true });
  });

  it("control: the same broad rule still widens a write inside the pod", async () => {
    const db = makeDb([[EVERYTHING_ALWAYS]]);
    expect(
      await resolveGovernanceRule({
        db,
        agentUserId: "agent-1",
        workspaceId: "ws-1",
        subjectType: "entity",
        action: "update",
      })
    ).toMatchObject({
      verdict: "auto",
      matchedPattern: "*",
      namesWrite: false,
    });
  });
});

/**
 * #4 instruction-provenance — rung 2.55's I/O half (`resolveOriginTrust`).
 * These prove the CLASSIFICATION half in isolation (the pure engine's
 * tighten-only mapping is covered in governance-policy/policy.test.ts). No
 * `userId` is passed, so the config_settings posture ladder is skipped and the
 * base channel classification is what's asserted (ONE channel read).
 */
describe("resolveOriginTrust (#4 origin classification)", () => {
  /** A channel row as `resolveOriginTrust` selects it. */
  function channelRow(overrides: {
    channelType: string;
    externalSource?: string | null;
    workspaceId?: string | null;
  }) {
    return {
      channelType: overrides.channelType,
      externalSource: overrides.externalSource ?? null,
      workspaceId: overrides.workspaceId ?? null,
    };
  }

  it("no channelId → undefined (rung 2.55 no-ops; never reads a channel)", async () => {
    // Empty queue: if it tried to read a channel this would return [] and still
    // resolve undefined, but the guard returns BEFORE any query.
    const db = makeDb([]);
    const trust = await resolveOriginTrust({ db, channelId: null });
    expect(trust).toBeUndefined();
  });

  it("EXTERNAL channel → untrusted", async () => {
    const db = makeDb([[channelRow({ channelType: ChannelType.EXTERNAL })]]);
    const trust = await resolveOriginTrust({ db, channelId: "chan-ext" });
    expect(trust).toBe("untrusted");
  });

  it("bridge / source-produced channel (externalSource set) → untrusted", async () => {
    const db = makeDb([
      [
        channelRow({
          channelType: ChannelType.THREAD,
          externalSource: "discord",
        }),
      ],
    ]);
    const trust = await resolveOriginTrust({ db, channelId: "chan-bridge" });
    expect(trust).toBe("untrusted");
  });

  it("owner-side PERSONAL channel (no external source) → trusted", async () => {
    const db = makeDb([[channelRow({ channelType: ChannelType.PERSONAL })]]);
    const trust = await resolveOriginTrust({ db, channelId: "chan-personal" });
    expect(trust).toBe("trusted");
  });

  it("channel not found → undefined (tighten-only: a lookup miss never fabricates a tightening)", async () => {
    const db = makeDb([[]]);
    const trust = await resolveOriginTrust({ db, channelId: "chan-missing" });
    expect(trust).toBeUndefined();
  });
});

/**
 * #4 ACTIVATION at the resolver: threading `channelId` into
 * `resolveAgentGovernanceDecision` now flows through rung 2.55, so a
 * would-be-auto agent write from an EXTERNAL channel force-proposes, while the
 * SAME write with no channel (or a trusted channel) is unchanged. Query order:
 * users → workspaces → governance_rules → (rung 2.55) channels → [ceiling reads
 * only when the base verdict is execute].
 */
describe("resolveAgentGovernanceDecision — #4 origin-trust activation via channelId", () => {
  it("EXTERNAL acting channel force-proposes an otherwise-auto write (entity.create)", async () => {
    const db = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [], // no governance rule
      [
        {
          channelType: ChannelType.EXTERNAL,
          externalSource: null,
          workspaceId: null,
        },
      ],
    ]);

    const result = await resolveAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create", // in DEFAULT_AUTO_APPROVE → would execute absent origin
      channelId: "chan-ext",
      preferAgentMetadataAutoApproveFor: true,
    });

    expect(result.decision).toBe("propose");
  });

  it("trusted PERSONAL acting channel leaves the auto write unchanged (execute)", async () => {
    const db = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [], // no governance rule
      [
        {
          channelType: ChannelType.PERSONAL,
          externalSource: null,
          workspaceId: null,
        },
      ],
      [], // resolveDailyWriteCeiling candidates → no row, no limit (no count read)
    ]);

    const result = await resolveAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      channelId: "chan-personal",
      preferAgentMetadataAutoApproveFor: true,
    });

    expect(result.decision).toBe("execute");
  });

  it("no acting channel is a no-op (execute — identical to pre-#4 behavior)", async () => {
    const db = makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [], // no governance rule
      // NO channel read is issued (channelId omitted → resolveOriginTrust returns
      // undefined before querying); the next queued rows are the ceiling reads.
      [], // resolveDailyWriteCeiling candidates → no row, no limit (no count read)
    ]);

    const result = await resolveAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      preferAgentMetadataAutoApproveFor: true,
    });

    expect(result.decision).toBe("execute");
  });
});

/**
 * W-B1: approving a held-writes pack replays each kept write as the agent
 * inside `runWithHeldWritesApproved`. The person answered the ceiling for
 * those writes, so rung 2.56 must not hold them again; outside that scope the
 * ceiling holds as before.
 */
/** A `governance_ceilings` candidate row, as `resolveCeiling` selects it. */
function ceilingRow(limitValue: number) {
  return {
    id: "ceiling-1",
    principalKind: "agent",
    scopeKind: "pod",
    subjectId: null,
    limitValue,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("resolveAgentGovernanceDecision — the daily ceiling and an approved held-writes replay", () => {
  const overCeiling = () =>
    makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [], // no governance rule
      [ceilingRow(500)], // resolveDailyWriteCeiling candidates → a 500/day row
      [{ n: 600 }], // countAgentWritesTodayUtc → over the ceiling
    ]);
  const input = {
    agentUserId: "agent-1",
    workspaceId: "ws-1",
    subjectType: "entity",
    action: "create",
    preferAgentMetadataAutoApproveFor: true,
  };

  it("over the ceiling, a would-be-auto write is held (propose, DAILY_WRITE_CEILING)", async () => {
    const result = await resolveAgentGovernanceDecision({
      db: overCeiling(),
      ...input,
    });
    expect(result).toMatchObject({
      decision: "propose",
      reasonCode: "DAILY_WRITE_CEILING",
    });
  });

  it("the replay of an approved held-writes pack is not held again (execute)", async () => {
    const result = await runWithHeldWritesApproved("pack-1", () =>
      resolveAgentGovernanceDecision({ db: overCeiling(), ...input })
    );
    expect(result.decision).toBe("execute");
  });
});

/**
 * The daily write ceiling is OPT-IN (founder, 2026-10-27): with no
 * `governance_ceilings` row there is no limit, however many writes the agent
 * made today; a stored row still holds at its limit.
 */
describe("resolveAgentGovernanceDecision — no ceiling row means no daily limit", () => {
  const input = {
    agentUserId: "agent-1",
    workspaceId: "ws-1",
    subjectType: "entity",
    action: "create",
    preferAgentMetadataAutoApproveFor: true,
  };
  const ladder = (ceilings: unknown[], writesToday: number) => {
    const queue: unknown[][] = [
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      [], // no governance rule
      ceilings, // resolveDailyWriteCeiling candidates
      [{ n: writesToday }], // countAgentWritesTodayUtc
    ];
    return { db: makeDb(queue), queue };
  };

  it("no row: an agent past 500 writes today still auto-executes, and its writes are not even counted", async () => {
    const { db, queue } = ladder([], 1_116);
    const result = await resolveAgentGovernanceDecision({ db, ...input });
    expect(result.decision).toBe("execute");
    // The count row was never read: no limit, nothing to count against.
    expect(queue).toEqual([[{ n: 1_116 }]]);
  });

  it("a row: the agent is held at that row's limit (propose, DAILY_WRITE_CEILING)", async () => {
    const { db } = ladder([ceilingRow(500)], 500);
    const result = await resolveAgentGovernanceDecision({ db, ...input });
    expect(result).toMatchObject({
      decision: "propose",
      reasonCode: "DAILY_WRITE_CEILING",
    });
  });

  it("a row: under its limit the write still auto-executes", async () => {
    const { db } = ladder([ceilingRow(500)], 499);
    const result = await resolveAgentGovernanceDecision({ db, ...input });
    expect(result.decision).toBe("execute");
  });
});
