/**
 * DRAFTS NEVER COUNT AS NEEDS-YOU (founder decision) — on PGlite, the REAL
 * SQL of the two halves `signals.count` / `signals.countByProject` read:
 *
 *   - the OWED half: `listOwedSlots({ excludeDrafts })` (what
 *     `focusSessions.owed({ excludeDrafts: true })` runs);
 *   - the DECISIONS half: `notUnderTriagePendingSessionWhere` (what
 *     `proposals.groups({ excludeDraftSessions: true })` pushes).
 *
 * Both reuse the ONE triage rule (`triage.ts`) the project path's default lens
 * applies. The forwarding of both flags by `signals` is pinned in
 * `routers/signals.scope.test.ts`.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, proposals, db, and, eq } from "@synap/database";
import { listOwedSlots } from "../owed-outputs.js";
import { notUnderTriagePendingSessionWhere } from "../triage.js";

const USER = "user-1";
const DRAFT = randomUUID();
const ACCEPTED = randomUUID();
const MINE = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "started_at" || c.name === "created_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const slot = (label: string) =>
  JSON.stringify([
    { kind: "document", label, owner: "human", owedSince: "2026-09-01" },
  ]);

beforeAll(async () => {
  for (const t of [focusSessions, proposals]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, origin, expected_outputs, agent_ids, metadata) values
      ($1, $4, 'Agent draft', 'active', 'agent', $5::jsonb, '{}', '{}'::jsonb),
      ($2, $4, 'Accepted agent work', 'active', 'agent', $6::jsonb, '{}', '{"triage":{"acceptedAt":"2026-09-02T00:00:00.000Z"}}'::jsonb),
      ($3, $4, 'My work', 'active', 'human', $7::jsonb, '{}', '{}'::jsonb)`,
    [
      DRAFT,
      ACCEPTED,
      MINE,
      USER,
      slot("Draft answer"),
      slot("Accepted answer"),
      slot("My answer"),
    ]
  );
  await h.client!.query(
    `insert into proposals (id, status, target_type, target_id, proposal_type, data, session_id) values
      (gen_random_uuid(), 'pending', 'entity', 'e1', 'create', '{}'::jsonb, $1),
      (gen_random_uuid(), 'pending', 'entity', 'e2', 'create', '{}'::jsonb, $2),
      (gen_random_uuid(), 'pending', 'entity', 'e3', 'create', '{}'::jsonb, null)`,
    [DRAFT, MINE]
  );
}, 120_000);

describe("a draft that owes a slot is not needs-you", () => {
  it("the owed half leaves the draft's slot out, and only when asked", async () => {
    const scope = { workspaceLens: undefined, projectLens: undefined };
    const all = await listOwedSlots({ userId: USER, scope, limit: 50 });
    expect(all.map((s) => s.sessionId).sort()).toEqual(
      [DRAFT, ACCEPTED, MINE].sort()
    );
    const needsYou = await listOwedSlots({
      userId: USER,
      scope,
      limit: 50,
      excludeDrafts: true,
    });
    // An ACCEPTED agent session is work, not a draft: its slot still counts.
    expect(needsYou.map((s) => s.sessionId).sort()).toEqual(
      [ACCEPTED, MINE].sort()
    );
  });

  it("the decisions half leaves out a proposal filed under the draft, keeps session-less ones", async () => {
    const rows = await db
      .select({ targetId: proposals.targetId })
      .from(proposals)
      .where(
        and(
          eq(proposals.status, "pending"),
          notUnderTriagePendingSessionWhere(proposals.sessionId)
        )
      );
    expect(rows.map((r) => r.targetId).sort()).toEqual(["e2", "e3"]);
  });
});
