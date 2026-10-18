/**
 * READ time — `statusMove`: a lifecycle move proposal (`entity.transition`)
 * names its move with the KIND's own options (label + category), its property
 * and its subject, through the real `enrichProposalsForDisplay` on PGlite with
 * the real access predicates. A subject the viewer may not read gets no
 * `statusMove`; a row that is not a move gets none either.
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client),
    // The lifecycle resolution is the move door's own (tested with it); here it
    // stands in for a "lead" kind whose lifecycle is declared on its profile.
    resolveStatusMoveTarget: async (
      _db: unknown,
      t: { entityId: string; role?: string | null }
    ) => ({
      ok: true,
      target: {
        entityId: t.entityId,
        entityType: "lead",
        workspaceId: null,
        facetId: null,
        role: t.role ?? null,
        current: "won",
        lifecycle: {
          propertySlug: "leadStage",
          propertyDefId: "def-1",
          declaredOnProfileId: "profile-1",
          unclassified: [],
          options: [
            { key: "new", category: "open" },
            { key: "qualified", label: "Sales qualified", category: "active" },
            { key: "won", category: "done" },
          ],
        },
      },
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { enrichProposalsForDisplay } from "./display.js";

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
});

function moveRow(
  entityId: string,
  payload: Record<string, unknown>,
  proposalType = "entity.transition"
) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType,
    targetType: "entity",
    targetId: entityId,
    data: {
      targetType: "entity",
      targetId: entityId,
      changeType: "transition",
      data: {
        id: entityId,
        entityId,
        role: null,
        facetId: null,
        property: "leadStage",
        ...payload,
      },
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

async function moveOf(r: never) {
  const [out] = await enrichProposalsForDisplay([r], VIEWER);
  return (out as unknown as { statusMove?: unknown }).statusMove;
}

describe("statusMove — the move, named by the kind's lifecycle", () => {
  it("names property, from/to with label + category, and the subject", async () => {
    expect(
      await moveOf(moveRow(ACME, { expectedFrom: "qualified", to: "won" }))
    ).toEqual({
      property: "leadStage",
      from: { key: "qualified", label: "Sales qualified", category: "active" },
      to: { key: "won", label: "Won", category: "done" },
      subjectKind: "lead",
      subjectName: "Acme Corp",
    });
  });

  it("from an initial (no) status is null; a row with no belief has no from", async () => {
    const initial = (await moveOf(
      moveRow(ACME, { expectedFrom: null, to: "new" })
    )) as { from?: unknown };
    expect(initial.from).toBeNull();
    const legacy = (await moveOf(moveRow(ACME, { to: "new" }))) as object;
    expect(legacy).not.toHaveProperty("from");
  });

  it("never for a subject the viewer may not read", async () => {
    expect(
      await moveOf(moveRow(HIDDEN_LEAD, { expectedFrom: "new", to: "won" }))
    ).toBeUndefined();
  });

  it("never for a row that is not a move", async () => {
    expect(
      await moveOf(moveRow(ACME, { to: "won" }, "entity.update"))
    ).toBeUndefined();
  });
});
