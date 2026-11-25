/**
 * PROVENANCE IS NOT A PLACE (finding 80cc8e12; founder, 23 Nov 2026).
 *
 * A pod-wide entity was made in the founder's own session of space A. Read
 * under the lens of space B, the session the entity was made in came back as a
 * HIDDEN neighbour: `hydrationScopeWhere`'s session case ANDs the lens onto the
 * session read rule, and a lens is a filter, not an access rule.
 *
 * The rule now: a provenance session (a `produced` link from it, or a derived
 * `produced_in` row: temporal, receipt, structure) hydrates WITHOUT the lens,
 * under the session read rule alone. So:
 *   - the OWNER reading under lens B sees the session, named by its goal, on
 *     every provenance route;
 *   - a MEMBER of both spaces who cannot read the session still gets it hidden
 *     (links) or dropped (derived folds), and never its goal or its id as a name;
 *   - a session reached by any OTHER edge (`targets`) keeps the lens.
 *
 * Driven through the real neighbour folds on PGlite with real SQL; nothing
 * between the stored row and the asserted field is hand-built. What this cannot
 * see: production Postgres constraints (tables are generated from the Drizzle
 * definitions without FKs / NOT NULL / enums).
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
  const db = drizzle(client);
  // The folds read through `getDb()`; the visibility helpers through `db`.
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { resolvePrivateObjectLabel } from "@synap-core/types/vocabulary";
import {
  getLinkNeighbors,
  getTemporalNeighbors,
  getReceiptNeighbors,
  getStructureNeighbors,
  isProvenanceSessionRef,
  type GraphNeighbor,
} from "./graph-service.js";

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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const OWNER = "owner-provenance";
const MEMBER = "member-provenance";
const SPACE_A = randomUUID(); // where the session lives
const SPACE_B = randomUUID(); // the lens the entity is read under
const SESSION_P = randomUUID(); // the provenance session (owner's, space A)
const SESSION_Q = randomUUID(); // the owner's other session: a `targets` edge
const ENTITY_E = randomUUID(); // pod-wide, made in P
const ENTITY_E2 = randomUUID(); // made by proposal R, filed in P
const PROPOSAL_R = randomUUID();
const P_GOAL = "Première validation : la source qui agrège la plupart";
const Q_GOAL = "Draft the pricing memo";
/** The reader's real facet scope under the lens of space B. */
const scopeOf = (userId: string) => ({
  userId,
  workspaceId: SPACE_B,
  allowedWorkspaceIds: [SPACE_A, SPACE_B],
});

const sessionRows = (out: GraphNeighbor[], sid: string) =>
  out.filter((n) => n.kind === "session" && n.id === sid);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  // Non-vacuity: every table the folds under test touch was created.
  for (const n of [
    "focus_sessions",
    "links",
    "events",
    "proposals",
    "entities",
    "users",
    "workspaces",
    "workspace_members",
  ]) {
    expect(byName.has(n)).toBe(true);
  }
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, MEMBER]) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    for (const ws of [SPACE_A, SPACE_B]) {
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
        [randomUUID(), ws, u]
      );
    }
  }
  for (const [ws, name] of [
    [SPACE_A, "A"],
    [SPACE_B, "B"],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      ws,
      name,
      OWNER,
    ]);
  }
  for (const [sid, goal] of [
    [SESSION_P, P_GOAL],
    [SESSION_Q, Q_GOAL],
  ]) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, created_at, updated_at, started_at)
       values ($1, $2, $3, $4, 'active', '{}'::jsonb, now(), now(), now())`,
      [sid, OWNER, SPACE_A, goal]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, created_at, updated_at)
     values ($1, $2, null, 'note', 'Acquisition target', '{}'::jsonb, now(), now())`,
    [ENTITY_E, OWNER]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, source_proposal_id, created_at, updated_at)
     values ($1, $2, $3, 'note', 'Shortlist', '{}'::jsonb, $4, now(), now())`,
    [ENTITY_E2, OWNER, SPACE_B, PROPOSAL_R]
  );
  // Both edges are filed in space B, so the edge itself passes the B lens:
  // only the far end's hydration decides what the reader sees.
  for (const [sid, linkType] of [
    [SESSION_P, "produced"],
    [SESSION_Q, "targets"],
  ]) {
    await q(
      `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
       values ($1, $2, 'session', $3, 'entity', $4, $5, '{}'::jsonb, now())`,
      [randomUUID(), SPACE_B, sid, ENTITY_E, linkType]
    );
  }
  // The events spine: a change to E made inside P, one row per reader (the
  // temporal scan floors on `events.user_id`).
  for (const u of [OWNER, MEMBER]) {
    await q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, session_id)
       values ($1, now(), 'entities.update.validated', $2, 'entity', '{}'::jsonb, $3, $4)`,
      [randomUUID(), ENTITY_E, u, SESSION_P]
    );
  }
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, session_id, created_by, created_at, updated_at)
     values ($1, $2, 'entity', $3, 'create', 'approved', '{}'::jsonb, $4, $5, now(), now())`,
    [PROPOSAL_R, SPACE_B, ENTITY_E2, SESSION_P, OWNER]
  );
});

describe("the provenance edge set", () => {
  it("is exactly an incoming produced / produced_in session", () => {
    const at = (edgeType: string, direction: "incoming" | "outgoing") =>
      isProvenanceSessionRef({ kind: "session", edgeType, direction });
    expect(at("produced", "incoming")).toBe(true);
    expect(at("produced_in", "incoming")).toBe(true);
    // Rows that would rule a looser predicate out.
    expect(at("produced", "outgoing")).toBe(false);
    expect(at("targets", "incoming")).toBe(false);
    expect(at("spawned_from", "incoming")).toBe(false);
    expect(
      isProvenanceSessionRef({
        kind: "entity",
        edgeType: "produced",
        direction: "incoming",
      })
    ).toBe(false);
  });
});

describe("owner, under the lens of another space: the session is named", () => {
  it("links: the produced edge names the session; the targets edge keeps the lens", async () => {
    const out = await getLinkNeighbors(
      OWNER,
      "entity",
      ENTITY_E,
      scopeOf(OWNER),
      SPACE_B
    );
    const [produced] = sessionRows(out, SESSION_P);
    expect(produced?.edgeType).toBe("produced");
    expect(produced?.hidden).toBeUndefined();
    expect(produced?.name).toContain("Première validation");
    expect(produced?.workspaceId).toBe(SPACE_A);
    // Narrow: a session reached by a non-provenance edge is still lensed.
    const [targets] = sessionRows(out, SESSION_Q);
    expect(targets?.edgeType).toBe("targets");
    expect(targets?.hidden).toBe(true);
    expect(targets?.name).toBe(resolvePrivateObjectLabel("session"));
  });

  it("temporal: the session the change happened in is a produced_in neighbour", async () => {
    const out = await getTemporalNeighbors(
      OWNER,
      "entity",
      ENTITY_E,
      scopeOf(OWNER),
      SPACE_B
    );
    const [row] = sessionRows(out, SESSION_P);
    expect(row?.edgeType).toBe("produced_in");
    expect(row?.name).toContain("Première validation");
  });

  it("receipt: the session the creating proposal was filed in", async () => {
    const out = await getReceiptNeighbors(
      OWNER,
      "entity",
      ENTITY_E2,
      scopeOf(OWNER),
      SPACE_B
    );
    // Non-vacuity: the receipt itself came back, so the session row is the
    // one under test, not an empty fold.
    expect(out.some((n) => n.kind === "proposal")).toBe(true);
    expect(sessionRows(out, SESSION_P)[0]?.name).toContain(
      "Première validation"
    );
  });

  it("structure: a proposal's own session", async () => {
    const out = await getStructureNeighbors(
      OWNER,
      "proposal",
      PROPOSAL_R,
      scopeOf(OWNER),
      SPACE_B
    );
    expect(out.some((n) => n.kind === "entity")).toBe(true);
    const [row] = sessionRows(out, SESSION_P);
    expect(row?.edgeType).toBe("produced_in");
    expect(row?.name).toContain("Première validation");
  });
});

describe("a member who cannot read the session: privacy unchanged", () => {
  const leaks = (out: GraphNeighbor[]) => {
    const text = JSON.stringify(out.map((n) => n.name));
    return text.includes("Première") || text.includes(SESSION_P);
  };

  it("links: the produced edge stays hidden, named by the private placeholder", async () => {
    const out = await getLinkNeighbors(
      MEMBER,
      "entity",
      ENTITY_E,
      scopeOf(MEMBER),
      SPACE_B
    );
    const [produced] = sessionRows(out, SESSION_P);
    expect(produced?.hidden).toBe(true);
    expect(produced?.name).toBe(resolvePrivateObjectLabel("session"));
    expect(leaks(out)).toBe(false);
  });

  it("temporal and structure: the session is dropped", async () => {
    const temporal = await getTemporalNeighbors(
      MEMBER,
      "entity",
      ENTITY_E,
      scopeOf(MEMBER),
      SPACE_B
    );
    expect(sessionRows(temporal, SESSION_P)).toEqual([]);
    const structure = await getStructureNeighbors(
      MEMBER,
      "proposal",
      PROPOSAL_R,
      scopeOf(MEMBER),
      SPACE_B
    );
    // The member reads the proposal (space B), so the fold ran.
    expect(structure.some((n) => n.kind === "entity")).toBe(true);
    expect(sessionRows(structure, SESSION_P)).toEqual([]);
    expect(leaks([...temporal, ...structure])).toBe(false);
  });
});
