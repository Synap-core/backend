/**
 * READ time — a stored `playbook/update` summary of just "Update Template"
 * (filed before `resolveProposalTargetName` read the playbook's name) is
 * re-derived to name the template, through `enrichProposalsForDisplay`: the
 * playbook id is batch-joined (`referencedNameIds` → `playbookById`, floored by
 * the playbook VisibilityRule) and feeds the `targetName` chain, and
 * `proposalDisplaySummary` swaps a summary that names no object for one that
 * does.
 *
 * Driven on PGlite with the real access predicates compiled to SQL. A playbook
 * the viewer cannot read keeps the bare title — the join never becomes an
 * oracle for a name.
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
  return { ...actual, db: drizzle(client) };
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
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status) values ($1,$2,$3,'Business Model (GRP)','g','active'),($4,$5,$6,$7,'g','active')`,
    [PB_SEEN, WS_SEEN, VIEWER, PB_HIDDEN, WS_HIDDEN, OTHER, HIDDEN_NAME]
  );
});

function updateRow(playbookId: string, summary: string) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType: "update",
    targetType: "playbook",
    targetId: playbookId,
    data: {
      requestId: randomUUID(),
      source: "intelligence",
      sourceId: VIEWER,
      workspaceId: WS_SEEN,
      targetType: "playbook",
      targetId: playbookId,
      changeType: "update",
      data: { id: playbookId, criteria: [] },
      summary,
    },
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: null,
    createdBy: VIEWER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
  } as never;
}

async function reviewSummary(row: never) {
  const [out] = await enrichProposalsForDisplay([row], VIEWER);
  return out as unknown as { review: { summary?: string } };
}

describe('read time — a stored "Update Template" names its playbook', () => {
  it("a playbook the viewer can read is named", async () => {
    const out = await reviewSummary(updateRow(PB_SEEN, "Update Template"));
    expect(out.review.summary).toBe('Update Template "Business Model (GRP)"');
  });

  it("a playbook the viewer cannot read is never named", async () => {
    const out = await reviewSummary(updateRow(PB_HIDDEN, "Update Template"));
    expect(out.review.summary).toBe("Update Template");
    expect(JSON.stringify(out)).not.toContain(HIDDEN_NAME);
  });
});
