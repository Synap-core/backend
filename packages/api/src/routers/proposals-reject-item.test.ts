/**
 * The per-item review doors — `proposals.rejectItem` / `restoreItem` — and the
 * batch approve receipt, driven through the REAL procedures on PGlite.
 *
 * Real: both procedures (pending guard, pack-ref check, the one-statement
 * disposition write) and `batchApprove`'s result assembly. The `proposals`
 * table is generated from its Drizzle definition, so every column exists.
 *
 * Stubbed, and why:
 *  - `assertCanReviewProposal` / `computeCanReviewApproval` — review authority
 *    has its own suites; allowed here so each case isolates the door.
 *  - `applyProposalApproval` — the executors have their own suites; it returns
 *    a receipt carrying `refusals`, which is what `batchApprove` must pass on.
 *  - `isPodReadOnly` — the split-brain guard every mutation passes; writable.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  refusals: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema: { proposals: actual.proposals as never } }),
  };
});
vi.mock("./proposals/review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertCanReviewProposal: vi.fn(async () => undefined),
  computeCanReviewApproval: vi.fn(async () => ({
    allowed: true,
    reason: "owner",
  })),
}));
vi.mock("./proposals/apply-approval.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyProposalApproval: vi.fn(async () => ({
    success: true,
    ...(h.refusals.length > 0 ? { refusals: h.refusals } : {}),
  })),
}));
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db, proposals } from "@synap/database";
import { proposalsRouter } from "./proposals.js";

const USER = "user-1";
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

async function seed(opts: {
  status?: string;
  data: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, created_at, updated_at)
     values ($1, $2, 'composite', 'entity', $3, $4::jsonb, $5, now(), now())`,
    [
      id,
      opts.status ?? "pending",
      randomUUID(),
      JSON.stringify(opts.data),
      USER,
    ]
  );
  return id;
}

async function dispositions(id: string): Promise<Record<string, unknown>> {
  const { rows } = await h.client!.query<{ d: Record<string, unknown> | null }>(
    `select data->'dispositions' as d from proposals where id = $1`,
    [id]
  );
  return rows[0]?.d ?? {};
}

const caller = () =>
  proposalsRouter.createCaller({
    db,
    authenticated: true,
    userId: USER,
  } as never);

/** The cleanup-pack shape: items that name their own `ref`. */
const PACK = {
  items: [
    { ref: "session:a", kind: "session" },
    { ref: "session:b", kind: "session" },
  ],
};
/** A composite graph: no `items[].ref`, keyed by `$opN` / op refs. */
const COMPOSITE = { operations: [{ op: "create_entity", ref: "n1" }] };

describe("proposals.rejectItem / restoreItem — per-item doors", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(proposals as unknown as PgTable));
  });
  beforeEach(async () => {
    await h.client!.exec("delete from proposals;");
    h.refusals = [];
  });

  it("PENDING guard: both doors refuse a decided proposal with CONFLICT and write nothing", async () => {
    const id = await seed({ status: "approved", data: PACK });

    await expect(
      caller().rejectItem({ proposalId: id, itemRef: "session:a" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      caller().restoreItem({ proposalId: id, itemRef: "session:a" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await dispositions(id)).toEqual({});
  });

  it("two concurrent toggles on different items BOTH persist", async () => {
    const id = await seed({ data: PACK });

    await Promise.all([
      caller().rejectItem({ proposalId: id, itemRef: "session:a" }),
      caller().rejectItem({ proposalId: id, itemRef: "session:b" }),
    ]);

    expect(await dispositions(id)).toEqual({
      "session:a": { status: "reject" },
      "session:b": { status: "reject" },
    });
  });

  it("restore removes only its own item, concurrently with a reject on another", async () => {
    const id = await seed({
      data: { ...PACK, dispositions: { "session:a": { status: "reject" } } },
    });

    await Promise.all([
      caller().restoreItem({ proposalId: id, itemRef: "session:a" }),
      caller().rejectItem({ proposalId: id, itemRef: "session:b" }),
    ]);

    expect(await dispositions(id)).toEqual({
      "session:b": { status: "reject" },
    });
  });

  it("pack shape: an unknown itemRef is refused with BAD_REQUEST; a known one is written", async () => {
    const id = await seed({ data: PACK });

    await expect(
      caller().rejectItem({ proposalId: id, itemRef: "session:typo" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().restoreItem({ proposalId: id, itemRef: "session:typo" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await dispositions(id)).toEqual({});

    await caller().rejectItem({ proposalId: id, itemRef: "session:a" });
    expect(await dispositions(id)).toEqual({
      "session:a": { status: "reject" },
    });
  });

  it("a composite with no items[].ref keeps accepting its $opN / op refs, unchanged", async () => {
    const id = await seed({ data: COMPOSITE });

    await caller().rejectItem({ proposalId: id, itemRef: "$op0" });
    await caller().rejectItem({ proposalId: id, itemRef: "n1" });
    expect(await dispositions(id)).toEqual({
      $op0: { status: "reject" },
      n1: { status: "reject" },
    });

    await caller().restoreItem({ proposalId: id, itemRef: "$op0" });
    expect(await dispositions(id)).toEqual({ n1: { status: "reject" } });
  });
});

describe("proposals.batchApprove — the receipt's refusals reach the caller", () => {
  beforeAll(async () => {
    const { rows } = await h.client!.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_name = 'proposals'`
    );
    if (rows[0]!.n === 0) {
      await h.client!.exec(ddlFor(proposals as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec("delete from proposals;");
    h.refusals = [];
  });

  it("an executor's refusals ride on that item's batch result", async () => {
    const id = await seed({ data: PACK });
    h.refusals = [
      "Weekly sync (session): Active again since this pack was filed.",
    ];

    const { results } = await caller().batchApprove({ proposalIds: [id] });

    expect(results).toEqual([
      {
        proposalId: id,
        success: true,
        refusals: [
          "Weekly sync (session): Active again since this pack was filed.",
        ],
      },
    ]);
  });

  it("no refusals → no refusals key (never an empty array claiming a check)", async () => {
    const id = await seed({ data: PACK });

    const { results } = await caller().batchApprove({ proposalIds: [id] });

    expect(results).toEqual([{ proposalId: id, success: true }]);
  });
});
