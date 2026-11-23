/**
 * Needs-you from what an approval landed: the REAL `listLandedNeedsPerson`
 * on PGlite (every table, the real access predicates, the real process read
 * that derives a next step), then the row the union draws from it.
 *
 * Rows where a naive reading disagrees: a landed automation that is already
 * on (its next is nothing: no row); one in a space the viewer cannot read
 * (left out, its name never served); another person's approval landing a
 * draft (not the viewer's to turn on); an approval older than the window;
 * the same draft landed by two approvals (one row, the newest).
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

import {
  allSchemaTables,
  pgliteSchemaDdl,
} from "../../__tests__/pglite-ddl.js";
import { listLandedNeedsPerson } from "./landed-needs.js";
import {
  signalFromLandedNeed,
  signalsFromAccessRequests,
} from "./needs-you-union.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const DRAFT = randomUUID();
const LIVE = randomUUID();
const HIDDEN = randomUUID();
const THEIRS = randomUUID();
const OLD = randomUUID();
/** A second person whose many newer receipts must not push their draft out. */
const BUSY = "busy-1";
const BUSY_DRAFT = randomUUID();

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function approved(p: {
  by: string;
  landed: Array<{ id: string }>;
  at: Date;
  workspaceId?: string;
}) {
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, created_by, subject_user_id, reviewed_by, data, created_at, updated_at)
     values ($1, $2, 'automation', $3, 'create', 'approved', $4, $4, $4, $5::jsonb, $6, $6)`,
    [
      randomUUID(),
      p.workspaceId ?? WS_SEEN,
      randomUUID(),
      p.by,
      JSON.stringify({
        landed: p.landed.map((l) => ({
          kind: "automation",
          id: l.id,
          role: "created",
        })),
      }),
      p.at,
    ]
  );
}

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner'),($7,$2,$6,'editor'),($8,$2,$9,'editor')`,
    [
      randomUUID(),
      WS_SEEN,
      VIEWER,
      randomUUID(),
      WS_HIDDEN,
      OTHER,
      randomUUID(),
      randomUUID(),
      BUSY,
    ]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name, status) values
       ($1,$6,$8,'New lead → qualify','draft'),
       ($2,$6,$8,'Weekly digest','active'),
       ($3,$7,$9,'Someone else''s rule','draft'),
       ($4,$6,$9,'Their draft','draft'),
       ($5,$6,$8,'Last month''s draft','draft')`,
    [DRAFT, LIVE, HIDDEN, THEIRS, OLD, WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name, status) values ($1,$2,$3,'Busy draft','draft')`,
    [BUSY_DRAFT, WS_SEEN, BUSY]
  );
  await approved({ by: BUSY, landed: [{ id: BUSY_DRAFT }], at: daysAgo(1) });
  await approved({
    by: VIEWER,
    landed: [{ id: DRAFT }, { id: LIVE }, { id: HIDDEN }],
    at: daysAgo(1),
  });
  await approved({ by: VIEWER, landed: [{ id: DRAFT }], at: daysAgo(2) });
  // The newest approval of all: no other row can hide it from a scan.
  await approved({
    by: OTHER,
    landed: [{ id: THEIRS }],
    at: new Date(Date.now() + 60_000),
  });
  await approved({ by: VIEWER, landed: [{ id: OLD }], at: daysAgo(30) });
  // The busy person's newer receipts that land no automation or playbook.
  for (let i = 0; i < 120; i++) {
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, created_by, subject_user_id, reviewed_by, data, created_at, updated_at)
       values ($1, $2, 'entity', $3, 'create', 'auto_approved', $4, $4, $4, '{}'::jsonb, now(), now())`,
      [randomUUID(), WS_SEEN, randomUUID(), BUSY]
    );
  }
}, 120_000);

describe("what the viewer's recent approvals landed that only they can take on", () => {
  it("one row per draft they may read, from their own recent approvals", async () => {
    const { rows } = await listLandedNeedsPerson({
      userId: VIEWER,
      roster: false,
    });
    expect(rows).toEqual([
      {
        kind: "automation",
        id: DRAFT,
        name: "New lead → qualify",
        action: "turn_on",
        landedAt: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("Someone else");
  });

  it("newer receipts that land nothing do not push a draft out of the scan", async () => {
    const { rows, truncated } = await listLandedNeedsPerson({
      userId: BUSY,
      roster: false,
    });
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.id)).toEqual([BUSY_DRAFT]);
  });

  it("another person's approval is not the viewer's to take on", async () => {
    const { rows } = await listLandedNeedsPerson({
      userId: VIEWER,
      roster: false,
    });
    expect(rows.map((r) => r.id)).not.toContain(THEIRS);
  });

  it("an approval older than the window is not read", async () => {
    const { rows } = await listLandedNeedsPerson({
      userId: VIEWER,
      roster: false,
    });
    expect(rows.map((r) => r.id)).not.toContain(OLD);
  });

  it("draws as an access-request row whose door is the object", () => {
    const need = {
      kind: "automation" as const,
      id: DRAFT,
      name: "New lead → qualify",
      action: "turn_on" as const,
      landedAt: daysAgo(1),
    };
    const signal = signalFromLandedNeed(need);
    // The union's access half carries it.
    expect(
      signalsFromAccessRequests({
        issuers: [],
        applications: [],
        landed: [need],
      })
    ).toEqual([signal]);
    expect(signal).toMatchObject({
      id: `access:landed:automation:${DRAFT}`,
      kind: "access-request",
      class: "access",
      target: { kind: "automation", id: DRAFT },
      access: { subject: "automation", name: "New lead → qualify", from: "" },
      lifetimeHours: null,
    });
    expect(signal.title).toContain("New lead → qualify");
  });

  it("once it is on, the row is gone", async () => {
    await q(`update automations set status = 'active' where id = $1`, [DRAFT]);
    const { rows } = await listLandedNeedsPerson({
      userId: VIEWER,
      roster: false,
    });
    expect(rows).toEqual([]);
  });
});
