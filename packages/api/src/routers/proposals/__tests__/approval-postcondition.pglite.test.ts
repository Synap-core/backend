/**
 * The status door and the approval tail, behaviourally (R4 option A, M3).
 *
 *  1. POSTCONDITION. An executor that reports success and writes no status
 *     (the #427 class: `skill/update`, `playbook/archive`, `entity/renderer.set`
 *     applied and stayed pending) still leaves the proposal APPROVED,
 *     attributed to the approver. Negative control: remove the
 *     `assertApprovalLanded` call in `completeProposalApproval`.
 *  2. PRECONDITION. A rejected / withdrawn / expired / reverted proposal is
 *     refused before its executor runs (it used to re-run and flip approved).
 *     Negative control: remove the `assertProposalMayBeApproved` call.
 *  3. THE DOOR'S GUARD. `transitionProposal` never moves a row the table does
 *     not let move: a decided proposal is not overwritten. Negative control:
 *     drop the `inArray(proposals.status, from)` from the door.
 *
 * Real: PGlite, `applyProposalApproval`, the registry dispatch and the door.
 * The executor is a probe registered under its own key, so no real executor's
 * side effects are involved.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  probeRuns: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  canTransitionProposal,
  PROPOSAL_TRANSITIONS,
  transitionProposal,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { applyProposalApproval } from "../apply-approval.js";
import { registerProposalExecutor } from "../execution-registry.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const REVIEWER = randomUUID();
const PROBE_TYPE = "status_door_probe";

/** The #427 shape: applies, reports success, never touches the status. */
registerProposalExecutor({
  // A probe key, not a real proposal type (the precedent: app-person-token).
  key: `${PROBE_TYPE}/noop` as never,
  async execute() {
    h.probeRuns++;
    return { success: true };
  },
});

async function file(status: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, comments, revision_history, workspace_id, created_at, updated_at)
     values ($1, $2, 'noop', $3, $4, $5::jsonb, '[]'::jsonb, '[]'::jsonb, null, now(), now())`,
    [
      id,
      status,
      PROBE_TYPE,
      randomUUID(),
      JSON.stringify({ ownerUserId: REVIEWER }),
    ]
  );
  return id;
}

async function approve(id: string) {
  const { db } = await import("@synap/database");
  const { eq } = await import("drizzle-orm");
  const proposal = await (
    db as unknown as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
  expect(proposal).toBeTruthy();
  return applyProposalApproval({
    proposal: proposal as never,
    userId: REVIEWER,
    input: { proposalId: id },
    ctx: { authenticated: true, userId: REVIEWER } as never,
  });
}

const rowOf = async (id: string) =>
  (
    await q<{ status: string; reviewed_by: string | null }>(
      `select status, reviewed_by from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
});

beforeEach(() => {
  h.probeRuns = 0;
});

describe("the approval tail's postcondition", () => {
  it("an executor that applied but wrote no status leaves the proposal APPROVED, by the approver", async () => {
    const id = await file(ProposalStatus.PENDING);
    const result = await approve(id);
    expect(result.success).toBe(true);
    expect(h.probeRuns).toBe(1);
    expect(await rowOf(id)).toEqual({
      status: ProposalStatus.APPROVED,
      reviewed_by: REVIEWER,
    });
  });

  it("a failed approval retried the same way lands approved too", async () => {
    const id = await file(ProposalStatus.APPROVAL_FAILED);
    await approve(id);
    expect((await rowOf(id)).status).toBe(ProposalStatus.APPROVED);
  });
});

describe("the approval precondition (the transition table)", () => {
  it.each([
    ProposalStatus.REJECTED,
    ProposalStatus.WITHDRAWN,
    ProposalStatus.EXPIRED,
    ProposalStatus.REVERTED,
  ])(
    "a %s proposal is refused before its executor runs, and keeps its status",
    async (status) => {
      const id = await file(status);
      await expect(approve(id)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(h.probeRuns).toBe(0);
      expect((await rowOf(id)).status).toBe(status);
    }
  );
});

describe("the status door", () => {
  it("never moves a row the table does not let move", async () => {
    const { db, eq } = (await import("@synap/database")) as unknown as {
      db: Parameters<typeof transitionProposal>[0];
      eq: typeof import("drizzle-orm").eq;
    };
    for (const status of [ProposalStatus.WITHDRAWN, ProposalStatus.EXPIRED]) {
      const id = await file(status);
      const moved = await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: { reviewedBy: REVIEWER },
        where: eq(schema.proposals.id, id),
      }).returning({ id: schema.proposals.id });
      expect(moved).toEqual([]);
      expect(await rowOf(id)).toEqual({ status, reviewed_by: null });
    }
    // An approved row is not overwritten by a rejection.
    const approved = await file(ProposalStatus.APPROVED);
    const rejected = await transitionProposal(db, {
      to: ProposalStatus.REJECTED,
      where: eq(schema.proposals.id, approved),
    }).returning({ id: schema.proposals.id });
    expect(rejected).toEqual([]);
    expect((await rowOf(approved)).status).toBe(ProposalStatus.APPROVED);
    // ...while an allowed move does land (non-vacuity of the two above).
    const pending = await file(ProposalStatus.PENDING);
    const ok = await transitionProposal(db, {
      to: ProposalStatus.REJECTED,
      where: eq(schema.proposals.id, pending),
    }).returning({ id: schema.proposals.id });
    expect(ok).toEqual([{ id: pending }]);
  });

  it("the table covers every status, and withdrawn / expired are final", () => {
    const statuses = Object.values(ProposalStatus);
    expect(Object.keys(PROPOSAL_TRANSITIONS).sort()).toEqual(
      [...statuses].sort()
    );
    for (const to of statuses) {
      expect(canTransitionProposal(ProposalStatus.WITHDRAWN, to)).toBe(false);
      expect(canTransitionProposal(ProposalStatus.EXPIRED, to)).toBe(false);
    }
    expect(
      canTransitionProposal(ProposalStatus.APPROVED, ProposalStatus.REJECTED)
    ).toBe(false);
    expect(
      canTransitionProposal(ProposalStatus.PENDING, ProposalStatus.APPROVED)
    ).toBe(true);
  });

  it("a caller naming a move the table refuses is a programming error", async () => {
    const { db, eq } = (await import("@synap/database")) as unknown as {
      db: Parameters<typeof transitionProposal>[0];
      eq: typeof import("drizzle-orm").eq;
    };
    expect(() =>
      transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        from: [ProposalStatus.WITHDRAWN],
        where: eq(schema.proposals.id, randomUUID()),
      })
    ).toThrow(/not in PROPOSAL_TRANSITIONS/);
  });
});
