import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-motif widening (founder D8, pod-side plan §5.3 F5).
 *
 * Drives the REAL `handleGovernanceLaneScan` over a routed db stub: each
 * `select().from(table).where(cond)` is answered from in-memory rows by
 * reading the condition the scanner built (`eq` / `ne` / `and` are recorded,
 * not executed), so the agent filter, the receipt exclusion and the widen
 * dedup query are all exercised as written. `insertPendingProposal` records
 * the filed rows AND adds them to the widen store, so a later pass in the same
 * scan sees what an earlier one filed. `@synap/governance-policy` is REAL: the
 * floor check asks the engine itself.
 *
 * NOT covered here: the SQL itself (no live PG); the approval and the rung-2.8
 * resolution of the stored rule (api `widen-lane-motif-approval.test.ts`).
 */

type Cond =
  | { op: "eq" | "ne"; col: string; val: unknown }
  | { op: "and"; conds: Cond[] }
  | { op: "isNull"; col: string };

interface ProposalRow {
  agentUserId: string | null;
  proposalType: string;
  targetType: string;
  targetId: string;
  data: unknown;
  status: string;
  createdAt: Date;
}

const store = {
  agents: [] as Array<{ id: string; createdByUserId: string | null }>,
  proposals: [] as ProposalRow[],
  rules: [] as Array<Record<string, unknown>>,
};
const filed: Array<Record<string, unknown>> = [];

function table(name: string, cols: string[]) {
  const t: Record<string, string> = { __table: name };
  for (const c of cols) t[c] = `${name}.${c}`;
  return t;
}

const tables = {
  proposals: table("proposals", [
    "agentUserId",
    "proposalType",
    "targetType",
    "targetId",
    "data",
    "status",
    "createdAt",
  ]),
  users: table("users", ["id", "createdByUserId", "userType"]),
  governanceRules: table("governanceRules", [
    "principalKind",
    "agentUserId",
    "revokedAt",
    "targetKind",
    "targetPattern",
  ]),
};

function leaves(c: Cond | undefined): Cond[] {
  if (!c) return [];
  return c.op === "and" ? c.conds.flatMap(leaves) : [c];
}

function matches(row: Record<string, unknown>, tableName: string, c: Cond[]) {
  return c.every((leaf) => {
    if (leaf.op === "isNull") return row[leaf.col.split(".")[1]!] == null;
    const key = leaf.col.split(".")[1]!;
    if (!leaf.col.startsWith(`${tableName}.`)) return true;
    return leaf.op === "eq" ? row[key] === leaf.val : row[key] !== leaf.val;
  });
}

function answer(tableName: string, cond: Cond | undefined): unknown[] {
  const c = leaves(cond);
  if (tableName === "users") {
    return store.agents.filter(() =>
      c.some((l) => l.op === "eq" && l.col === "users.userType")
    );
  }
  if (tableName === "proposals") {
    return store.proposals
      .filter((r) =>
        matches(r as unknown as Record<string, unknown>, tableName, c)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  return store.rules.filter((r) => matches(r, tableName, c));
}

const db = {
  select: () => ({
    from: (t: { __table: string }) => ({
      where: (cond: Cond) => {
        const rows = () => answer(t.__table, cond);
        const q = {
          orderBy: () => q,
          limit: async (n: number) => rows().slice(0, n),
          then: (resolve: (r: unknown[]) => void) => resolve(rows()),
        };
        return q;
      },
    }),
  }),
};

vi.mock("@synap/database", () => ({
  db,
  ...tables,
  insertPendingProposal: vi.fn(async (input: Record<string, unknown>) => {
    filed.push(input);
    store.proposals.push({
      agentUserId: null,
      proposalType: input.proposalType as string,
      targetType: input.targetType as string,
      targetId: input.targetId as string,
      data: input.data,
      status: "pending",
      createdAt: new Date(),
    });
    return { proposal: { id: `widen-${filed.length}` }, deduped: false };
  }),
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  ne: (col: string, val: unknown) => ({ op: "ne", col, val }),
  and: (...conds: Cond[]) => ({ op: "and", conds }),
  isNull: (col: string) => ({ op: "isNull", col }),
  desc: (col: string) => col,
  ProposalStatus: {
    PENDING: "pending",
    APPROVED: "approved",
    AUTO_APPROVED: "auto_approved",
    REJECTED: "rejected",
    REVERTED: "reverted",
    WITHDRAWN: "withdrawn",
    EXPIRED: "expired",
    APPROVAL_FAILED: "approval_failed",
  },
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(async () => undefined),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  handleGovernanceLaneScan,
  computeMotifQualifications,
  qualifiesMotifForWidenLane,
  motifWidenRefusal,
} = await import("../governance-lane-scanner.js");

const AGENT = "agent-cc";
const OWNER = "owner-1";
let clock = 0;

/** `n` rows of one motif by AGENT, each on its own target (no duplicates). */
function motifRows(
  n: number,
  status: string,
  targetType: string,
  proposalType: string,
  opts: { agent?: string; targetIdPrefix?: string } = {}
): ProposalRow[] {
  return Array.from({ length: n }, (_, i) => ({
    agentUserId: opts.agent ?? AGENT,
    proposalType,
    targetType,
    targetId: `${opts.targetIdPrefix ?? `${targetType}-${status}`}-${i}`,
    data: {},
    status,
    createdAt: new Date(1_800_000_000_000 + clock++),
  }));
}

function widenRow(
  status: string,
  targetPattern: string,
  agentUserId = AGENT
): ProposalRow {
  return {
    agentUserId: null,
    proposalType: "governance.widen_lane",
    targetType: "governance",
    targetId: agentUserId,
    data: {
      agentUserId,
      targetKind: "action",
      targetPattern,
      scopeKind: "pod",
    },
    status,
    createdAt: new Date(1_800_000_000_000 + clock++),
  };
}

const HAND_OFF = "focus_session.assign_agent";

beforeEach(() => {
  store.agents = [{ id: AGENT, createdByUserId: OWNER }];
  store.proposals = [];
  store.rules = [];
  filed.length = 0;
  clock = 0;
});

describe("per-motif widening — a qualifying motif", () => {
  it("40 fully-approved hand-offs file ONE widen for that motif only", async () => {
    store.proposals.push(
      ...motifRows(40, "approved", "focus_session", "assign_agent"),
      // Another motif the person keeps rejecting: never widened.
      ...motifRows(5, "rejected", "skill", "update")
    );

    await handleGovernanceLaneScan();

    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      proposalType: "governance.widen_lane",
      targetType: "governance",
      targetId: AGENT,
      createdBy: OWNER,
      subjectUserId: OWNER,
      workspaceId: null,
      data: {
        agentUserId: AGENT,
        targetKind: "action",
        targetPattern: HAND_OFF,
        scopeKind: "pod",
        verdict: "auto",
        evidence: {
          total: 40,
          approveRate: 1,
          duplicateRate: 0,
          basis: "motif",
          motif: { targetType: "focus_session", proposalType: "assign_agent" },
        },
      },
    });
  });

  it("two motifs that each qualify file one widen each", async () => {
    store.proposals.push(
      ...motifRows(30, "approved", "focus_session", "assign_agent"),
      ...motifRows(30, "approved", "entity", "update")
    );
    await handleGovernanceLaneScan();
    const patterns = filed.map(
      (f) => (f.data as { targetPattern: string }).targetPattern
    );
    expect(patterns.sort()).toEqual(["entity.update", HAND_OFF]);
  });

  it("an agent the agent-wide gate also qualifies gets its dominant motif filed ONCE", async () => {
    // 120 approved hand-offs: agent-wide (>=100) AND per-motif both qualify
    // the same pattern. The motif pass reads the widen the agent pass filed.
    store.proposals.push(
      ...motifRows(120, "approved", "focus_session", "assign_agent")
    );
    await handleGovernanceLaneScan();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.data).toMatchObject({ targetPattern: HAND_OFF });
    expect(
      (filed[0]!.data as { evidence: { basis?: string } }).evidence.basis
    ).toBeUndefined(); // the agent-wide gate filed it, unchanged
  });
});

describe("per-motif widening — below a threshold, nothing", () => {
  it("29 decisions (volume floor is 30)", async () => {
    store.proposals.push(
      ...motifRows(29, "approved", "focus_session", "assign_agent")
    );
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("approve rate exactly 0.95 (38 of 40) — the gate is strictly above", async () => {
    store.proposals.push(
      ...motifRows(38, "approved", "focus_session", "assign_agent"),
      ...motifRows(2, "rejected", "focus_session", "assign_agent")
    );
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("a revert counts as a 'no' (39 approved + 3 reverted = 0.929)", async () => {
    store.proposals.push(
      ...motifRows(39, "approved", "focus_session", "assign_agent"),
      ...motifRows(3, "reverted", "focus_session", "assign_agent")
    );
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("15% duplicates (the gate is strictly below)", async () => {
    // 40 decided; 6 of them re-file 3 targets twice → 6/40 = 0.15.
    const rows = motifRows(40, "approved", "focus_session", "assign_agent");
    rows[1]!.targetId = rows[0]!.targetId;
    rows[3]!.targetId = rows[2]!.targetId;
    rows[5]!.targetId = rows[4]!.targetId;
    store.proposals.push(...rows);
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("pending re-files count as duplicates even though nobody judged them", async () => {
    store.proposals.push(
      ...motifRows(30, "approved", "focus_session", "assign_agent", {
        targetIdPrefix: "s",
      }),
      // The same 6 sessions handed again, still waiting: 12 of 36 in clusters.
      ...motifRows(6, "pending", "focus_session", "assign_agent", {
        targetIdPrefix: "s",
      })
    );
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("receipts are not decisions: 200 auto-applied writes of a motif file nothing", async () => {
    store.proposals.push(
      ...motifRows(200, "auto_approved", "entity", "entity.update"),
      // 20 rejections elsewhere keep the AGENT-wide gate shut (200/220 < 0.95),
      // so only the motif gate could file entity.update — and must not.
      ...motifRows(20, "rejected", "skill", "update")
    );
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("receipts are not decisions (pure): the motif scores zero decisions", () => {
    const [m] = computeMotifQualifications(
      motifRows(200, "auto_approved", "entity", "entity.update")
    );
    expect(m).toMatchObject({ targetPattern: "entity.update", decisions: 0 });
    expect(qualifiesMotifForWidenLane(m!)).toBe(false);
  });

  it("partial approvals (gutted composites) are not full approvals", () => {
    const rows = motifRows(40, "approved", "focus_session", "assign_agent");
    for (const r of rows.slice(0, 3)) {
      r.data = {
        dispositions: {
          $op0: { status: "accept" },
          $op1: { status: "reject", reasonCode: "wrong_target" },
        },
      };
    }
    const [m] = computeMotifQualifications(rows);
    expect(m!.approveRate).toBe(0.925);
    expect(qualifiesMotifForWidenLane(m!)).toBe(false);
  });
});

describe("per-motif widening — floors are never widened", () => {
  it("40 approved deletes file nothing (DESTRUCTIVE floor sits above rung 2.8)", async () => {
    store.proposals.push(...motifRows(40, "approved", "entity", "delete"));
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("the refusal comes from the engine's floors, and from the gate door set", () => {
    expect(motifWidenRefusal("entity.delete")).toBe("DESTRUCTIVE_HARD_FLOOR");
    expect(motifWidenRefusal("automation.create")).toBe(
      "AGENT_STRUCTURE_WRITE"
    );
    // A `direct` door: rung 2.8 never resolves an action rule for it.
    expect(motifWidenRefusal("capability.run")).toBe("NOT_A_GATE_DOOR");
    // A key no door emits.
    expect(motifWidenRefusal("entity.create_composite")).toBe(
      "NOT_A_GATE_DOOR"
    );
    expect(motifWidenRefusal(HAND_OFF)).toBeNull();
    expect(motifWidenRefusal("entity.update")).toBeNull();
  });
});

describe("per-motif widening — dedup", () => {
  const qualifying = () =>
    motifRows(40, "approved", "focus_session", "assign_agent");

  for (const status of ["pending", "approved", "rejected"]) {
    it(`a ${status} widen for the same (agent, motif) is not refiled`, async () => {
      store.proposals.push(...qualifying(), widenRow(status, HAND_OFF));
      await handleGovernanceLaneScan();
      expect(filed).toEqual([]);
    });
  }

  for (const status of ["withdrawn", "expired"]) {
    it(`a ${status} widen does not block a refile`, async () => {
      store.proposals.push(...qualifying(), widenRow(status, HAND_OFF));
      await handleGovernanceLaneScan();
      expect(filed).toHaveLength(1);
    });
  }

  it("a pending widen for ANOTHER motif or ANOTHER agent does not block", async () => {
    store.proposals.push(
      ...qualifying(),
      widenRow("pending", "entity.update"),
      widenRow("rejected", HAND_OFF, "agent-other")
    );
    await handleGovernanceLaneScan();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.data).toMatchObject({ targetPattern: HAND_OFF });
  });

  it("an active rule already covering the motif is not re-proposed", async () => {
    store.proposals.push(...qualifying());
    store.rules.push({
      principalKind: "agent",
      agentUserId: AGENT,
      revokedAt: null,
      targetKind: "action",
      targetPattern: "focus_session.*",
    });
    await handleGovernanceLaneScan();
    expect(filed).toEqual([]);
  });

  it("a second scan the next day files nothing new", async () => {
    store.proposals.push(...qualifying());
    await handleGovernanceLaneScan();
    await handleGovernanceLaneScan();
    expect(filed).toHaveLength(1);
  });
});
