/**
 * W0 — an app's approved requests can NEVER widen into their cross product.
 *
 * The owner approves "create People in Sales" and "read Notes in Finance".
 * Driven through the REAL chain on PGlite: `grantsForApprovedRequests` →
 * `attachGrantsOrRevoke` (the grant write door) → `GrantRepository
 * .resolveForKey` (what every key-auth door enters) → `checkPermissionOrPropose`
 * (the write gate) and `keyGrantReadClause` (the read floor).
 *
 * Rows that rule out a wrong rule:
 *  - People in Finance must be DENIED — the flattened single grant
 *    (all permissions × all workspaces) permits it;
 *  - People in Sales must NOT be grant-denied — a "deny everything" fix
 *    passes the first row and fails this one;
 *  - reading a person in Finance reads nothing, reading a note there does.
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { GrantRepository, runWithGrant, type KeyGrant } from "@synap/database";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import { grantsForApprovedRequests } from "./app-connect.js";
import { keyGrantReadClause } from "../access/grant-read.js";

const SALES = randomUUID();
const FINANCE = randomUUID();
const KEY = randomUUID();
const PERSON_IN_FINANCE = randomUUID();
const NOTE_IN_FINANCE = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" ? " default now()" : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

let keyGrant: KeyGrant;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `insert into entities (id, type, user_id, workspace_id)
     values ($1, 'person', 'human-1', $3), ($2, 'note', 'human-1', $3)`,
    [PERSON_IN_FINANCE, NOTE_IN_FINANCE, FINANCE]
  );
  await attachGrantsOrRevoke({
    apiKeyId: KEY,
    principalUserId: "human-1",
    onBehalfOf: "human-1",
    grants: grantsForApprovedRequests([
      { permission: "entity.person.create", workspaceId: SALES },
      { permission: "entity.note.read", workspaceId: FINANCE },
    ]),
    expiresAt: null,
    createdBy: "human-1",
    clientId: "app_test",
  });
  const resolved = await new GrantRepository(h.db as never).resolveForKey(KEY);
  keyGrant = resolved!;
});

const createPerson = (workspaceId: string) =>
  runWithGrant(keyGrant, () =>
    checkPermissionOrPropose({
      userId: "human-1",
      workspaceId,
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "person", title: "Ada" },
    } as Parameters<typeof checkPermissionOrPropose>[0])
  ).catch((e: unknown) => ({ thrown: String(e) }));

const grantDenied = (r: unknown) =>
  /grant does not allow/.test(
    (r as { reason?: string }).reason ?? ""
  );

const visible = async (workspace: string) => {
  const clause = keyGrantReadClause(schema.entities, keyGrant);
  const { and, eq } = await import("drizzle-orm");
  const rows = await (h.db as any)
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(and(eq(schema.entities.workspaceId, workspace), clause));
  return rows.map((r: { id: string }) => r.id).sort();
};

describe("app grants are one scope per approved workspace (W0)", () => {
  it("the key carries the app identity and one scope per workspace", () => {
    expect(keyGrant.clientId).toBe("app_test");
    expect(keyGrant.scopes).toHaveLength(2);
  });

  it("can NOT create People in Finance (the cross product)", async () => {
    expect(grantDenied(await createPerson(FINANCE))).toBe(true);
  });

  it("is not grant-denied creating People in Sales (what was approved)", async () => {
    const r = await createPerson(SALES);
    expect(grantDenied(r)).toBe(false);
    // It went PAST the grant rung (no membership row exists in this harness,
    // so the next rung answers) — not a thrown error read as "not denied".
    expect((r as { reason?: string }).reason).toMatch(/not a member/);
  });

  it("reads Notes in Finance but not People there", async () => {
    expect(await visible(FINANCE)).toEqual([NOTE_IN_FINANCE]);
  });
});
