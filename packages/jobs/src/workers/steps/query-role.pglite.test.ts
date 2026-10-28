/**
 * The automation `query` step selects entities by ROLE, through the pod's
 * polymorphic profile scope (role → facet-EXISTS under the automation's own
 * space and owner; kind → `entities.type`, unchanged).
 *
 * Live (28 Oct 2026): the weekly announcement flow (automation bdb99e5d) asks
 * for `filter: { roleCategory: "announcement-material" }` — every note wearing
 * the `proof-point` role. The step matched `entities.type` only and required a
 * profileSlug, so the flow failed on its first step and never drafted a post
 * (finding 1c2dfe3d).
 *
 * Rows that rule out a wrong rule: a note WITHOUT the role ("return every
 * note"); the role attached in ANOTHER space ("ignore the facet lens"); a role
 * of ANOTHER category ("any facet will do"); a finding (the kind branch must
 * stay a plain type match).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | { exec: (sql: string) => Promise<unknown> },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { executeQueryStep } from "./query.js";
import type { StepContext } from "../automation-executor-types.js";

const OWNER = randomUUID();
const SPACE = randomUUID(); // the automation's space (Content OS)
const OTHER_SPACE = randomUUID();

const NOTE_KIND = randomUUID();
const FINDING_KIND = randomUUID();
const PROOF_ROLE = randomUUID();
const MEMBER_ROLE = randomUUID();

const PROOF = randomUUID(); // a note wearing proof-point in SPACE: selected
const PLAIN = randomUUID(); // a note with no role
const ELSEWHERE = randomUUID(); // proof-point attached in OTHER_SPACE only
const MEMBER = randomUUID(); // a role of another category
const FINDING = randomUUID(); // a finding (kind) in SPACE

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

/** Every schema table, derived from drizzle so a new column never breaks this. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const ctx = {
  trigger: { payload: {}, subject: null },
  steps: {},
  automation: { id: "a1", state: {} },
} as unknown as StepContext;

const idsOf = (out: Record<string, unknown>) =>
  ((out.entities as Array<{ id: string }>) ?? []).map((e) => e.id).sort();

const query = (data: Record<string, unknown>) =>
  executeQueryStep(
    { limit: 50, ...data } as Parameters<typeof executeQueryStep>[0],
    ctx,
    SPACE,
    OWNER
  );

beforeAll(async () => {
  await h.init();
  const tables = Object.values(schema).filter((t): t is PgTable => {
    try {
      getTableConfig(t as PgTable);
      return true;
    } catch {
      return false;
    }
  });
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await h.client!.exec(`
    insert into profiles (id, slug, display_name, profile_kind, role_category, is_active, workspace_id) values
      ('${NOTE_KIND}', 'note', 'Note', 'kind', null, true, null),
      ('${FINDING_KIND}', 'finding', 'Finding', 'kind', null, true, null),
      ('${PROOF_ROLE}', 'proof-point', 'Proof point', 'role', 'announcement-material', true, '${SPACE}'),
      ('${MEMBER_ROLE}', 'team-member', 'Team member', 'role', 'workspace-membership', true, null);
    insert into entities (id, user_id, workspace_id, type, profile_id, title, properties) values
      ('${PROOF}', '${OWNER}', null, 'note', '${NOTE_KIND}', 'A dogfood pass fixed 3 defects', '{}'),
      ('${PLAIN}', '${OWNER}', null, 'note', '${NOTE_KIND}', 'A plain note', '{}'),
      ('${ELSEWHERE}', '${OWNER}', null, 'note', '${NOTE_KIND}', 'A win filed in another space', '{}'),
      ('${MEMBER}', '${OWNER}', null, 'note', '${NOTE_KIND}', 'A note with another role', '{}'),
      ('${FINDING}', '${OWNER}', '${SPACE}', 'finding', '${FINDING_KIND}', 'A pain', '{}');
    insert into entity_facets (id, entity_id, profile_id, workspace_id, user_id, properties) values
      ('${randomUUID()}', '${PROOF}', '${PROOF_ROLE}', '${SPACE}', '${OWNER}', '{}'),
      ('${randomUUID()}', '${ELSEWHERE}', '${PROOF_ROLE}', '${OTHER_SPACE}', '${OWNER}', '{}'),
      ('${randomUUID()}', '${MEMBER}', '${MEMBER_ROLE}', '${SPACE}', '${OWNER}', '{}');
  `);
}, 120_000);

describe("query step: selecting by role", () => {
  it("the live announcement node (roleCategory nested in filter) selects only the proof point", async () => {
    // Verbatim the q-wins node of automation bdb99e5d.
    const out = await query({
      filter: { roleCategory: "announcement-material" },
      orderBy: "createdAt",
      orderDir: "desc",
    });
    expect(idsOf(out)).toEqual([PROOF]);
  });

  it("a role slug selects the entities wearing it, under the automation's space", async () => {
    expect(idsOf(await query({ profileSlug: "proof-point" }))).toEqual([PROOF]);
  });

  it("a kind slug is unchanged: the plain type match", async () => {
    expect(idsOf(await query({ profileSlug: "finding" }))).toEqual([FINDING]);
    expect(idsOf(await query({ profileSlug: "note" }))).toEqual(
      [PROOF, PLAIN, ELSEWHERE, MEMBER].sort()
    );
  });

  it("a category no profile carries is an empty cohort, not a failure", async () => {
    await expect(query({ roleCategory: "no-such-category" })).resolves.toEqual({
      entities: [],
      count: 0,
    });
  });

  it("a node with neither selector still fails, naming both", async () => {
    await expect(query({})).rejects.toThrow(
      /profileSlug or roleCategory is required/
    );
  });
});
