/**
 * READ time — `before`: a PENDING session update that rewrites criteria or
 * expected outputs carries the session's CURRENT criteria + outputs, so the
 * card draws before → after on the session. Through the real
 * `enrichProposalsForDisplay` on PGlite with the real session read rule. Never
 * on a decided row (the live row is then the after), never for a session the
 * viewer may not read, never for an update that does not touch them.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const MINE = randomUUID();
const THEIRS = randomUUID();
const CRITERIA_NOW = [{ label: "Deck has 10 slides" }];
const OUTPUTS_NOW = [{ label: "Pitch deck", kind: "document" }];

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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { enrichProposalsForDisplay } from "./display.js";
import { resolveSessionBefore } from "./session-before.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const PB_SEEN = randomUUID();
const PB_HIDDEN = randomUUID();
const HIDDEN_NAME = "Other's secret template";
const RULE = randomUUID();
const ACME = randomUUID();
const BETA = randomUUID();
const HIDDEN_LEAD = randomUUID();
const HIDDEN_LEAD_NAME = "Somebody else's lead";

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

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS_SEEN, VIEWER, randomUUID(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status) values ($1,$2,$3,'Qualify a lead','g','active'),($4,$5,$6,$7,'g','active')`,
    [PB_SEEN, WS_SEEN, VIEWER, PB_HIDDEN, WS_HIDDEN, OTHER, HIDDEN_NAME]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name) values ($1,$2,$3,'New lead → qualify')`,
    [RULE, WS_SEEN, VIEWER]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$4,$5,'lead','Acme Corp'),($2,$4,$5,'lead','Beta Ltd'),($3,$6,$7,'lead',$8)`,
    [
      ACME,
      BETA,
      HIDDEN_LEAD,
      VIEWER,
      WS_SEEN,
      OTHER,
      WS_HIDDEN,
      HIDDEN_LEAD_NAME,
    ]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, criteria, expected_outputs) values ($1,$2,$3,'Ship the deck','Ship the deck','active',$4::jsonb,$5::jsonb),($6,$7,$8,'Their session','Their session','active','[]'::jsonb,'[]'::jsonb)`,
    [
      MINE,
      VIEWER,
      WS_SEEN,
      JSON.stringify(CRITERIA_NOW),
      JSON.stringify(OUTPUTS_NOW),
      THEIRS,
      OTHER,
      WS_HIDDEN,
    ]
  );
});

function updateRow(
  sessionId: string,
  payload: Record<string, unknown>,
  status = "pending"
) {
  const now = new Date();
  return {
    id: randomUUID(),
    status,
    proposalType: "focus_session.update",
    targetType: "focus_session",
    targetId: sessionId,
    data: {
      targetType: "focus_session",
      targetId: sessionId,
      changeType: "update",
      data: { id: sessionId, goal: "Ship the deck", ...payload },
    },
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: VIEWER,
    createdBy: VIEWER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
  } as never;
}

async function beforeOf(r: never) {
  const [out] = await enrichProposalsForDisplay([r], VIEWER);
  return (out as unknown as { before?: unknown }).before;
}

describe("before — the session's current criteria and outputs", () => {
  it("a pending criteria/outputs rewrite carries the current ones", async () => {
    expect(
      await beforeOf(
        updateRow(MINE, { criteria: [{ label: "Deck has 12 slides" }] })
      )
    ).toEqual({ criteria: CRITERIA_NOW, expectedOutputs: OUTPUTS_NOW });
  });

  it("never on a decided row, nor an update that does not touch them", async () => {
    expect(
      await beforeOf(updateRow(MINE, { criteria: [] }, "approved"))
    ).toBeUndefined();
    expect(await beforeOf(updateRow(MINE, { title: "New" }))).toBeUndefined();
  });

  it("never for a session the viewer may not read", async () => {
    expect(
      await beforeOf(updateRow(THEIRS, { expectedOutputs: [] }))
    ).toBeUndefined();
  });

  it("the session read rule floors its own read (not only the row redaction upstream)", async () => {
    // Called directly: `enrichProposalsForDisplay` already strips an unreadable
    // session's payload first, which would hide a missing floor here.
    const out = await resolveSessionBefore(
      [
        {
          status: "pending",
          targetType: "focus_session",
          targetId: THEIRS,
          payload: { id: THEIRS, criteria: [] },
        },
      ],
      { userId: VIEWER, roster: false }
    );
    expect(out).toEqual([undefined]);
  });
});
