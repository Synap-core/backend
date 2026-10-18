/**
 * `proposals.list({ targetType: "library" })` — an agent's pending Library
 * organisation (`library/organize`) is listable for the person it was filed
 * for, through the REAL `list` procedure on PGlite; another person's is not
 * (the visibility floor still applies), and the filter keeps other targets out.
 * Every BY-ID door (get, source, approve, revise, reject, reopen, withdraw,
 * revert, batch approve/reject, the shared visibility gates) answers NOT_FOUND
 * to anyone but that person — a POD ADMIN included.
 *
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions with no FKs, NOT NULL or enums).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("@synap/storage", () => ({ storage: {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { proposalsRouter } from "../proposals.js";

const VIEWER = "viewer-lib";
const OTHER = "other-lib";
const AGENT = "agent-lib";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const MINE = randomUUID();
const THEIRS = randomUUID();
const ENTITY = randomUUID();

const list = (userId: string, input: Record<string, unknown>) =>
  proposalsRouter
    .createCaller({ db, authenticated: true, userId } as never)
    .list({ status: "pending", limit: 50, ...input } as never) as Promise<{
    items: Array<{ id: string; proposalType: string; data?: unknown }>;
  }>;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, email, user_type) values ($1, 'v@test', 'human'), ($2, 'o@test', 'human'), ($3, 'a@test', 'agent')`,
    [VIEWER, OTHER, AGENT]
  );
  // OTHER is a POD ADMIN: the Library floor holds even for them.
  const podAdminWs = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, system_slug) values ($1, 'Pod admin', $2, 'pod-admin')`,
    [podAdminWs, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'admin')`,
    [randomUUID(), podAdminWs, OTHER]
  );
  const rows: Array<[string, string, string, string]> = [
    [MINE, "library", "organize", VIEWER],
    [THEIRS, "library", "organize", OTHER],
    [ENTITY, "entity", "create", VIEWER],
  ];
  for (const [id, targetType, proposalType, owner] of rows) {
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, created_by, subject_user_id, created_at, updated_at)
       values ($1, null, $2, $3, $4, 'pending', $5::jsonb, $6, $6, $7, now(), now())`,
      [
        id,
        targetType,
        randomUUID(),
        proposalType,
        // As the gate stores it: `sourceId` = the HUMAN the agent acts for.
        JSON.stringify({
          sourceId: owner,
          data: {
            ops: [{ op: "group.build", groupId: randomUUID() }],
            groups: [],
            items: [],
            summary: "Build group",
          },
        }),
        AGENT,
        owner,
      ]
    );
  }
}, 120_000);

describe("proposals.list — targetType library", () => {
  it("the person sees their own pending organise proposal, nobody else's, and only library ones", async () => {
    const mine = await list(VIEWER, { targetType: "library" });
    expect(mine.items.map((r) => r.id)).toEqual([MINE]);
    expect(mine.items[0]!.proposalType).toBe("organize");
    const theirs = await list(OTHER, { targetType: "library" });
    expect(theirs.items.map((r) => r.id)).toEqual([THEIRS]);
  });

  it("NON-VACUITY: without the filter the viewer's entity proposal is listed too", async () => {
    const all = await list(VIEWER, {});
    expect(new Set(all.items.map((r) => r.id))).toEqual(
      new Set([MINE, ENTITY])
    );
  });
});

describe("by-id proposal doors — a Library proposal is its person's alone", () => {
  const as = (userId: string) =>
    proposalsRouter.createCaller({
      db,
      authenticated: true,
      userId,
    } as never) as unknown as Record<
      string,
      (input: unknown) => Promise<unknown>
    >;

  it("the shared gates: assertProposalVisibleTo NOT_FOUND for a pod admin, ok for the person; the batch gate drops it", async () => {
    const { assertProposalVisibleTo, visibleProposalIds } =
      await import("../../utils/proposal-visibility.js");
    await expect(assertProposalVisibleTo(MINE, OTHER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      assertProposalVisibleTo(MINE, VIEWER)
    ).resolves.toBeUndefined();
    // CONTROL: the pod admin still sees a non-library pod-wide proposal.
    await expect(
      assertProposalVisibleTo(ENTITY, OTHER)
    ).resolves.toBeUndefined();
    expect(
      [...(await visibleProposalIds([MINE, THEIRS, ENTITY], OTHER))].sort()
    ).toEqual([THEIRS, ENTITY].sort());
  });

  it("get / source / approve / revise / reject / reopen / withdraw / revert / rejectItem / restoreItem → NOT_FOUND for anyone else", async () => {
    const other = as(OTHER);
    const calls: Array<[string, unknown]> = [
      ["get", { proposalId: MINE }],
      ["source", { proposalId: MINE }],
      ["approve", { proposalId: MINE }],
      ["revise", { proposalId: MINE, data: { summary: "x" } }],
      ["reject", { proposalId: MINE }],
      ["reopen", { proposalId: MINE }],
      ["withdraw", { proposalId: MINE }],
      ["revert", { proposalId: MINE }],
      ["rejectItem", { proposalId: MINE, itemRef: "$op0" }],
      ["restoreItem", { proposalId: MINE, itemRef: "$op0" }],
    ];
    for (const [door, input] of calls) {
      await expect(other[door]!(input), door).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    // The person themselves reaches the proposal.
    await expect(as(VIEWER).get!({ proposalId: MINE })).resolves.toBeTruthy();
  });

  it("batch approve / reject record NOT_FOUND per item and change nothing", async () => {
    const other = as(OTHER);
    const approved = (await other.batchApprove!({ proposalIds: [MINE] })) as {
      results: Array<{ success: boolean; error?: string }>;
    };
    expect(approved.results[0]).toMatchObject({ success: false });
    await other.batchReject!({ proposalIds: [MINE] }).catch(() => undefined);
    const status = (
      await q(`select status from proposals where id = $1`, [MINE])
    ).rows[0] as { status: string };
    expect(status.status).toBe("pending");
  });
});
