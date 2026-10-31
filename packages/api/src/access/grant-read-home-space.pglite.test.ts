/**
 * HOME-SPACE REACH of a key grant (founder decision e1b59d38 "A",
 * 2026-10-30): an app granted space S reads the POD-WIDE records filed FOR S
 * (`entities.home_workspace_id = S`), as a member of S does, and their bodies
 * with `document.read`. A record homed elsewhere, or with no home, stays out.
 *
 * Through the REAL `scopedDb(AccessContext).findMany` on PGlite inside
 * `runWithGrant`, as the PERSON (an app key reads as its owner). The CONTROL
 * (no grant) shows the person's floor admits every row below, so each row a
 * granted read drops is the GRANT at work, not the floor.
 *
 * Rows rule out: no home reach at all (the gap this closes: D_CRM unread), a
 * reach that ignores WHICH space is home (D_OTHER read), one that reads an
 * un-homed pod-wide row (D_NONE read), one that reaches a STORED row by its
 * home (T_STORED_OTHER read), the kind narrowing dropped, and bodies left
 * behind or shared for a trashed record.
 *
 * Cannot see: production Postgres constraints (tables come from the Drizzle
 * definitions without FKs / NOT NULL / enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documents, entities } from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { AccessContext, scopedDb } from "./index.js";

const PERSON = "home-person"; // the app's owner: its reads run as this floor

const CRM = randomUUID();
const OTHER = randomUUID();
const DECISION_KIND = randomUUID();
const TASK_KIND = randomUUID();

const D_CRM = randomUUID(); // pod-wide decision filed for CRM       → read
const D_OTHER = randomUUID(); // pod-wide decision filed for OTHER   → not
const D_NONE = randomUUID(); // pod-wide decision, no home           → not
const T_CRM = randomUUID(); // pod-wide task filed for CRM          → kind
const T_STORED_OTHER = randomUUID(); // stored in OTHER, home CRM    → not
const D_TRASHED = randomUUID(); // pod-wide, home CRM, trashed

const B_CRM = randomUUID(); // body of D_CRM
const B_OTHER = randomUUID(); // body of D_OTHER
const B_NONE = randomUUID(); // body of D_NONE
const B_TRASHED = randomUUID(); // body of D_TRASHED

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
const sorted = (ids: string[]) => [...new Set(ids)].sort();

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    PERSON,
    `${PERSON}@x.test`,
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), PERSON]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$3,'{}'::jsonb),($2,'Other',$3,'{}'::jsonb)`,
    [CRM, OTHER, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$3,'owner')`,
    [randomUUID(), CRM, PERSON, randomUUID(), OTHER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values
       ($1,'decision','Decision','kind','system',null),
       ($2,'task','Task','kind','system',null)`,
    [DECISION_KIND, TASK_KIND]
  );
  const entity = (
    id: string,
    kind: "decision" | "task",
    ws: string | null,
    home: string | null,
    doc: string | null = null,
    trashed = false
  ) =>
    q(
      `insert into entities (id, type, profile_id, user_id, workspace_id, home_workspace_id, document_id, deleted_at, title)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'e')`,
      [
        id,
        kind,
        kind === "decision" ? DECISION_KIND : TASK_KIND,
        PERSON,
        ws,
        home,
        doc,
        trashed ? new Date() : null,
      ]
    );
  await entity(D_CRM, "decision", null, CRM, B_CRM);
  await entity(D_OTHER, "decision", null, OTHER, B_OTHER);
  await entity(D_NONE, "decision", null, null, B_NONE);
  await entity(T_CRM, "task", null, CRM);
  await entity(T_STORED_OTHER, "task", OTHER, CRM);
  await entity(D_TRASHED, "decision", null, CRM, B_TRASHED, true);
  for (const d of [B_CRM, B_OTHER, B_NONE, B_TRASHED]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,null,'Doc','markdown',1,1)`,
      [d, PERSON]
    );
  }
}, 120_000);

const read = async (table: object, grant?: GrantScope) => {
  const run = () =>
    scopedDb(AccessContext.operator({ userId: PERSON })).findMany<{
      id: string;
    }>(table);
  const rows = grant
    ? await runWithGrant(grantOfScope(grant), run)
    : await run();
  return sorted(rows.map((r) => r.id));
};

const CRM_READ: GrantScope = {
  permissions: ["entity.read"],
  workspaceIds: [CRM],
};

describe("CONTROL — no grant: the person's floor admits every row", () => {
  it("entities and bodies", async () => {
    const seen = await read(entities);
    for (const id of [D_CRM, D_OTHER, D_NONE, T_CRM, T_STORED_OTHER])
      expect(seen).toContain(id);
    const bodies = await read(documents);
    for (const id of [B_CRM, B_OTHER, B_NONE]) expect(bodies).toContain(id);
  });
});

describe("an app granted CRM reads the pod-wide records filed for CRM", () => {
  it("reads the pod-wide decision and task homed in CRM", async () => {
    const seen = await read(entities, CRM_READ);
    expect(seen).toContain(D_CRM);
    expect(seen).toContain(T_CRM);
  });

  it("NOT one homed in another space, one with no home, or one STORED elsewhere whatever its home", async () => {
    const seen = await read(entities, CRM_READ);
    expect(seen).not.toContain(D_OTHER);
    expect(seen).not.toContain(D_NONE);
    expect(seen).not.toContain(T_STORED_OTHER);
    // D_TRASHED: homed in CRM too; dropping a trashed row is the list doors'
    // filter (`deleted_at`), not the grant's.
    expect(seen).toEqual(sorted([D_CRM, T_CRM, D_TRASHED]));
  });

  it("a kind-qualified grant still narrows: decisions only", async () => {
    expect(
      await read(entities, {
        permissions: ["entity.decision.read"],
        workspaceIds: [CRM],
      })
    ).toEqual(sorted([D_CRM, D_TRASHED]));
  });

  it("granted OTHER instead, it reads OTHER's and not CRM's", async () => {
    const seen = await read(entities, {
      permissions: ["entity.decision.read"],
      workspaceIds: [OTHER],
    });
    expect(seen).toEqual([D_OTHER]);
  });

  it("bodies follow with document.read: the homed record's, not the others', not a trashed one's", async () => {
    expect(
      await read(documents, {
        permissions: ["document.read"],
        workspaceIds: [CRM],
      })
    ).toEqual([B_CRM]);
  });
});
