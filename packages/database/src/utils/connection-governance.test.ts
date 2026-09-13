/**
 * Per-connection governance.
 *
 * DB-free: a fake handle serves queued query results in call order and records
 * writes. It does NOT exercise the real SQL predicates (scope/principal/active
 * filtering) — fixtures are written as if the WHERE clause already ran, the same
 * limitation `resolve-agent-governance-decision.test.ts` states. Concurrency of
 * `ensureConnectionAutoRule` (the advisory lock) is likewise not provable here;
 * the test asserts the lock statement is issued inside the transaction.
 */

import { describe, it, expect } from "vitest";
import {
  resolveConnectionSyncDecision,
  ensureConnectionAutoRule,
  disableConnectionAutoRule,
  applyConnectionSyncApproval,
  readConnectionSync,
  isConnectionSyncProposal,
  applyConnectionSyncApprovalForProposal,
  isPodWideConnectionSyncApproval,
} from "./connection-governance.js";
import { resolveGovernanceRule } from "./resolve-agent-governance-decision.js";

interface FakeDb {
  inserts: unknown[];
  updates: number;
  executes: number;
  transactions: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: any;
}

/** Each `select` consumes the next queued result; writes are recorded. */
function makeDb(selectQueue: unknown[][], insertedId = "rule-new"): FakeDb {
  const state: FakeDb = {
    inserts: [],
    updates: 0,
    executes: 0,
    transactions: 0,
    handle: undefined,
  };
  const whereResult = (rows: unknown[]) => ({
    limit: async () => rows,
    then: (resolve: (r: unknown[]) => void) => resolve(rows),
  });
  const handle = {
    select: () => ({
      from: () => ({
        where: () => whereResult(selectQueue.shift() ?? []),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        state.inserts.push(v);
        return { returning: async () => [{ id: insertedId }] };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          state.updates += 1;
          const rows = [{ id: "rule-revoked" }];
          return {
            returning: async () => rows,
            then: (resolve: (r: unknown) => void) => resolve(undefined),
          };
        },
      }),
    }),
    execute: async () => {
      state.executes += 1;
      return [];
    },
    transaction: async (cb: (tx: unknown) => unknown) => {
      state.transactions += 1;
      return cb(handle);
    },
  };
  state.handle = handle;
  return state;
}

const SCOPE = {
  userId: "user-1",
  workspaceId: "ws-1",
  connectionId: "conn-1",
};

function rule(
  verdict: "auto" | "propose",
  scopeKind: "workspace" | "pod",
  id = `rule-${verdict}-${scopeKind}`,
  createdAt = new Date("2026-09-01T00:00:00Z")
) {
  return { id, verdict, scopeKind, createdAt };
}

describe("resolveConnectionSyncDecision", () => {
  it("no rule → propose, source none (never the default whitelist)", async () => {
    const f = makeDb([[]]);
    await expect(
      resolveConnectionSyncDecision({ ...SCOPE, db: f.handle })
    ).resolves.toEqual({ verdict: "propose", source: "none" });
  });

  it("an auto rule → auto, naming the rule", async () => {
    const f = makeDb([[rule("auto", "pod")]]);
    await expect(
      resolveConnectionSyncDecision({ ...SCOPE, db: f.handle })
    ).resolves.toEqual({
      verdict: "auto",
      ruleId: "rule-auto-pod",
      source: "rule",
    });
  });

  it("a workspace-scope propose rule outranks a newer pod-scope auto rule", async () => {
    const f = makeDb([
      [
        rule("auto", "pod", "pod-auto", new Date("2026-09-10T00:00:00Z")),
        rule("propose", "workspace", "ws-propose"),
      ],
    ]);
    const d = await resolveConnectionSyncDecision({ ...SCOPE, db: f.handle });
    expect(d).toMatchObject({ verdict: "propose", ruleId: "ws-propose" });
  });

  it("FLOOR: an auto rule never auto-applies a destructive write", async () => {
    for (const action of ["delete", "archive", "merge"]) {
      const f = makeDb([[rule("auto", "workspace")]]);
      const d = await resolveConnectionSyncDecision({
        ...SCOPE,
        db: f.handle,
        subjectType: "entity",
        action,
      });
      expect(d.verdict, action).toBe("propose");
      expect(d.source).toBe("rule");
      expect(d.reason).toBeTruthy();
    }
  });

  it("an auto rule applies an update", async () => {
    const f = makeDb([[rule("auto", "workspace")]]);
    const d = await resolveConnectionSyncDecision({
      ...SCOPE,
      db: f.handle,
      action: "update",
    });
    expect(d.verdict).toBe("auto");
  });
});

describe("rung 2.8 never matches a connection rule", () => {
  it("a connection row whose pattern equals the capabilityId does not match", async () => {
    const f = makeDb([
      [
        {
          id: "conn-rule",
          principalKind: "any",
          scopeKind: "pod",
          targetKind: "connection",
          targetPattern: "shared-id",
          targetProfile: null,
          verdict: "auto",
          createdAt: new Date(),
        },
      ],
    ]);
    const match = await resolveGovernanceRule({
      db: f.handle,
      agentUserId: "agent-1",
      workspaceId: null,
      subjectType: "capability",
      action: "execute",
      capabilityId: "shared-id",
      capabilityVerbName: "shared-id",
    });
    expect(match).toBeUndefined();
  });
});

describe("ensureConnectionAutoRule", () => {
  it("inserts ONE auto rule with proposal lineage when none is active", async () => {
    const f = makeDb([[]]);
    const res = await ensureConnectionAutoRule({
      ...SCOPE,
      db: f.handle,
      sourceProposalId: "prop-1",
    });
    expect(res).toEqual({ ruleId: "rule-new", created: true });
    expect(f.transactions).toBe(1);
    expect(f.executes).toBe(1); // the per-connection advisory lock
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0]).toMatchObject({
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: "ws-1",
      targetKind: "connection",
      targetPattern: "conn-1",
      verdict: "auto",
      sourceProposalId: "prop-1",
      createdBy: "user:user-1",
    });
  });

  it("is idempotent: an active auto rule is returned, nothing inserted", async () => {
    const f = makeDb([[{ id: "rule-existing", verdict: "auto" }]]);
    const res = await ensureConnectionAutoRule({
      ...SCOPE,
      db: f.handle,
      sourceProposalId: "prop-2",
    });
    expect(res).toEqual({ ruleId: "rule-existing", created: false });
    expect(f.inserts).toHaveLength(0);
    expect(f.updates).toBe(0);
  });

  it("a pod-wide sync mints a pod-scope rule", async () => {
    const f = makeDb([[]]);
    await ensureConnectionAutoRule({
      ...SCOPE,
      workspaceId: null,
      db: f.handle,
      sourceProposalId: "prop-3",
    });
    expect(f.inserts[0]).toMatchObject({ scopeKind: "pod", workspaceId: null });
  });

  it("revokes an active propose rule before inserting (newer consent wins)", async () => {
    const f = makeDb([[{ id: "rule-propose", verdict: "propose" }]]);
    const res = await ensureConnectionAutoRule({
      ...SCOPE,
      db: f.handle,
      sourceProposalId: "prop-4",
    });
    expect(res.created).toBe(true);
    expect(f.updates).toBe(1);
    expect(f.inserts).toHaveLength(1);
  });
});

describe("disableConnectionAutoRule", () => {
  it("revokes and reports the revoked ids", async () => {
    const f = makeDb([]);
    await expect(
      disableConnectionAutoRule({ ...SCOPE, db: f.handle })
    ).resolves.toEqual({ revokedRuleIds: ["rule-revoked"] });
    expect(f.updates).toBe(1);
  });
});

describe("applyConnectionSyncApproval (the approval hook)", () => {
  const importProposal = (connectionSync: unknown) => ({
    id: "prop-1",
    proposalType: "import.graph",
    workspaceId: "ws-1",
    data: { operations: [], connectionSync },
  });
  const CS = { connectionId: "conn-1", provider: "google", kinds: ["contact"] };

  it("approving a keep-syncing import mints exactly one auto rule", async () => {
    // select 1: secrets owner; select 2: active rules (none)
    const f = makeDb([[{ userId: "user-1" }], []]);
    const out = await applyConnectionSyncApproval({
      db: f.handle,
      proposal: importProposal({ ...CS, keepSyncing: true }),
      userId: "user-1",
    });
    expect(out).toEqual({ applied: true, ruleId: "rule-new", created: true });
    expect(f.inserts).toHaveLength(1);
  });

  it("re-approving (replay) is idempotent — no second rule", async () => {
    const f = makeDb([
      [{ userId: "user-1" }],
      [{ id: "rule-new", verdict: "auto" }],
    ]);
    const out = await applyConnectionSyncApproval({
      db: f.handle,
      proposal: importProposal(CS),
      userId: "user-1",
    });
    expect(out).toEqual({ applied: true, ruleId: "rule-new", created: false });
    expect(f.inserts).toHaveLength(0);
  });

  it("keepSyncing: false → no rule, no write", async () => {
    const f = makeDb([]);
    const out = await applyConnectionSyncApproval({
      db: f.handle,
      proposal: importProposal({ ...CS, keepSyncing: false }),
      userId: "user-1",
    });
    expect(out).toEqual({ applied: false, skipped: "keep-syncing-off" });
    expect(f.inserts).toHaveLength(0);
    expect(f.transactions).toBe(0);
  });

  it("an approver who does not own the connection earns no rule", async () => {
    const f = makeDb([[{ userId: "someone-else" }]]);
    const out = await applyConnectionSyncApproval({
      db: f.handle,
      proposal: importProposal(CS),
      userId: "user-1",
    });
    expect(out).toEqual({ applied: false, skipped: "not-connection-owner" });
    expect(f.inserts).toHaveLength(0);
  });

  it("a non-import proposal or plain import is not a connection sync", async () => {
    const f = makeDb([]);
    await expect(
      applyConnectionSyncApproval({
        db: f.handle,
        proposal: { ...importProposal(CS), proposalType: "capture.graph" },
        userId: "user-1",
      })
    ).resolves.toEqual({ applied: false, skipped: "not-import-graph" });
    await expect(
      applyConnectionSyncApproval({
        db: f.handle,
        proposal: { ...importProposal(CS), data: { operations: [] } },
        userId: "user-1",
      })
    ).resolves.toEqual({ applied: false, skipped: "not-connection-sync" });
    expect(f.inserts).toHaveLength(0);
  });

  it("readConnectionSync keeps a broken stamp distinct from no stamp", () => {
    expect(readConnectionSync({})).toBeUndefined();
    expect(readConnectionSync({ connectionSync: { provider: "google" } })).toBe(
      "malformed"
    );
    expect(readConnectionSync({ connectionSync: CS })).toEqual({
      connectionId: "conn-1",
    });
    expect(
      readConnectionSync({ connectionSync: { ...CS, keepSyncing: false } })
    ).toEqual({ connectionId: "conn-1", keepSyncing: false });
    expect(readConnectionSync({ connectionSync: [CS] })).toBe("malformed");
  });
});

describe("proposal-keyed seams (approval reactor + origin lookup)", () => {
  const PROP = "3f4c1a2b-1111-4111-8111-111111111111";

  it("isConnectionSyncProposal: a non-uuid id is false WITHOUT a query", async () => {
    let selects = 0;
    const handle = {
      select: () => {
        selects += 1;
        throw new Error("must not query");
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      isConnectionSyncProposal("receipt-123", handle as any)
    ).resolves.toBe(false);
    expect(selects).toBe(0);
  });

  it("isConnectionSyncProposal: true when the row matches, false when not", async () => {
    await expect(
      isConnectionSyncProposal(PROP, makeDb([[{ id: PROP }]]).handle)
    ).resolves.toBe(true);
    await expect(
      isConnectionSyncProposal(PROP, makeDb([[]]).handle)
    ).resolves.toBe(false);
  });

  it("the id-keyed hook earns nothing for a proposal that is not approved", async () => {
    const f = makeDb([
      [
        {
          id: PROP,
          proposalType: "import.graph",
          workspaceId: "ws-1",
          status: "pending",
          data: { connectionSync: { connectionId: "conn-1" } },
        },
      ],
    ]);
    await expect(
      applyConnectionSyncApprovalForProposal({
        db: f.handle,
        proposalId: PROP,
        userId: "user-1",
      })
    ).resolves.toEqual({ applied: false, skipped: "proposal-not-approved" });
    expect(f.inserts).toHaveLength(0);
  });

  it("the id-keyed hook mints the rule for an approved keep-syncing import", async () => {
    const f = makeDb([
      [
        {
          id: PROP,
          proposalType: "import.graph",
          workspaceId: "ws-1",
          status: "approved",
          data: { connectionSync: { connectionId: "conn-1", kinds: [] } },
        },
      ],
      [{ userId: "user-1" }],
      [],
    ]);
    await expect(
      applyConnectionSyncApprovalForProposal({
        db: f.handle,
        proposalId: PROP,
        userId: "user-1",
      })
    ).resolves.toEqual({ applied: true, ruleId: "rule-new", created: true });
    expect(f.inserts[0]).toMatchObject({ sourceProposalId: PROP });
  });
});

describe("isPodWideConnectionSyncApproval (approval path enqueues only where no reactor will)", () => {
  const CS = { connectionSync: { connectionId: "conn-1", kinds: [] } };

  it("pod-wide connection-sync import → true", () => {
    expect(
      isPodWideConnectionSyncApproval({
        proposalType: "import.graph",
        workspaceId: null,
        data: CS,
      })
    ).toBe(true);
    expect(
      isPodWideConnectionSyncApproval({
        proposalType: "import.graph",
        workspaceId: undefined,
        data: CS,
      })
    ).toBe(true);
  });

  it("workspace-scoped connection-sync import → false (the proposal.approved reactor covers it; no double enqueue)", () => {
    expect(
      isPodWideConnectionSyncApproval({
        proposalType: "import.graph",
        workspaceId: "ws-1",
        data: CS,
      })
    ).toBe(false);
  });

  it("a malformed stamp still enqueues (the worker reports it, it is never silently dropped)", () => {
    expect(
      isPodWideConnectionSyncApproval({
        proposalType: "import.graph",
        workspaceId: null,
        data: { connectionSync: { provider: "google" } },
      })
    ).toBe(true);
  });

  it("an ordinary pod-wide import or another proposal type → false", () => {
    expect(
      isPodWideConnectionSyncApproval({
        proposalType: "import.graph",
        workspaceId: null,
        data: {},
      })
    ).toBe(false);
    expect(
      isPodWideConnectionSyncApproval({
        proposalType: "capture.graph",
        workspaceId: null,
        data: CS,
      })
    ).toBe(false);
  });
});
