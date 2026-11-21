/**
 * READ time — `landed`: what an applied proposal's approval made, through the
 * real `enrichProposalsForDisplay` on PGlite with the real access predicates
 * and the real process read. Each object the viewer may read comes back named,
 * with its role and its next step; one the viewer may not read is left out.
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

import { allSchemaTables, pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const DRAFT_RULE = randomUUID();
const LIVE_RULE = randomUUID();
const HIDDEN_RULE = randomUUID();
const BOARD = randomUUID();

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS_SEEN, VIEWER, randomUUID(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name, status) values
       ($1,$4,$5,'New lead → qualify','draft'),
       ($2,$4,$5,'Weekly digest','active'),
       ($3,$6,$7,'Someone else''s rule','draft')`,
    [DRAFT_RULE, LIVE_RULE, HIDDEN_RULE, WS_SEEN, VIEWER, WS_HIDDEN, OTHER]
  );
  await q(
    `insert into views (id, workspace_id, user_id, type, category, name) values ($1,$2,$3,'kanban','structured','Leads board')`,
    [BOARD, WS_SEEN, VIEWER]
  );
}, 120_000);

function row(status: string, data: Record<string, unknown>) {
  const now = new Date();
  return {
    id: randomUUID(),
    status,
    proposalType: "create",
    targetType: "automation",
    targetId: randomUUID(),
    data,
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: VIEWER,
    createdBy: VIEWER,
    reviewedBy: VIEWER,
    createdAt: now,
    updatedAt: now,
  } as never;
}

async function landedOf(status: string, data: Record<string, unknown>) {
  const [out] = await enrichProposalsForDisplay([row(status, data)], VIEWER);
  return (out as unknown as { landed?: unknown }).landed;
}

describe("landed — what an approval made, as doors with their next step", () => {
  it("names each object from the stamp, with its next step", async () => {
    const landed = await landedOf("approved", {
      landed: [
        { kind: "automation", id: DRAFT_RULE, role: "created" },
        { kind: "automation", id: LIVE_RULE, role: "updated" },
        { kind: "view", id: BOARD, role: "created" },
        { kind: "automation", id: HIDDEN_RULE, role: "created" },
      ],
    });
    expect(landed).toEqual([
      {
        id: DRAFT_RULE,
        kind: "automation",
        name: "New lead → qualify",
        role: "created",
        next: { action: "turn_on", reason: "draft" },
      },
      {
        id: LIVE_RULE,
        kind: "automation",
        name: "Weekly digest",
        role: "updated",
        next: null,
      },
      { id: BOARD, kind: "view", name: "Leads board", role: "created" },
    ]);
  });

  it("reads a row approved before the stamp from what its apply recorded", async () => {
    const landed = await landedOf("approved", {
      materialized: {
        automationIds: [DRAFT_RULE],
        relationIds: [randomUUID()],
      },
    });
    expect(landed).toEqual([
      expect.objectContaining({
        id: DRAFT_RULE,
        kind: "automation",
        role: "created",
        next: expect.objectContaining({ action: "turn_on" }),
      }),
    ]);
  });

  it("a row still to decide landed nothing", async () => {
    expect(
      await landedOf("pending", {
        landed: [{ kind: "automation", id: DRAFT_RULE, role: "created" }],
      })
    ).toBeUndefined();
  });
});
