/**
 * APP ATTRIBUTION (App Connect v1) — the write EVENT records the app id.
 *
 * `auditLog` is the ONE event-spine append door. This drives it with the REAL
 * `EventRepository.append` (and the real `SynapEventSchema`) against a PGlite
 * `events` table, inside `runWithGrant` — the write context the key-auth doors
 * enter. Pinned: a grant carrying `clientId` stamps `events.app_id` next to
 * `user_id` (the connecting human); no grant / no app leaves it NULL.
 *
 * It also proves the field is NOT silently stripped by `SynapEventSchema` — the
 * exact way a fully-plumbed provenance field has reached zero rows before.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  sql: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  // EventRepository talks to raw sql via `sql.unsafe(text, params)`; PGlite's
  // `query` returns `{ rows }`, so the shim unwraps to the rows array append()
  // expects.
  h.sql = {
    unsafe: async (text: string, params: unknown[]) =>
      (await client.query(text, params)).rows,
  };
  return { ...actual, db: h.db, getDb: async () => h.db, sql: h.sql };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
import { SynapEventSchema } from "@synap-core/core";
import { auditLog } from "./audit-log.js";

const APP = "app_99999999-8888-4777-8666-555555555555";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

beforeEach(async () => {
  await h.client!.exec("DELETE FROM events");
});

/** Append one completed event through auditLog, inside a grant when given. */
async function emit(
  grant: { permissions: string[]; clientId?: string } | null
) {
  const subjectId = randomUUID();
  const run = () =>
    auditLog({
      subjectType: "entity",
      action: "create",
      phase: "completed",
      subjectId,
      userId: "human-1",
      workspaceId: null,
    });
  await (grant
    ? runWithGrant(grantOfScope(grant, grant.clientId ?? null), run)
    : run());
  const { rows } = await h.client!.query<{ app_id: string | null }>(
    "SELECT app_id FROM events WHERE subject_id = $1",
    [subjectId]
  );
  return rows[0]?.app_id ?? null;
}

describe("app attribution on the write event (App Connect v1)", () => {
  it("stamps events.app_id from the request's grant clientId", async () => {
    expect(await emit({ permissions: ["*"], clientId: APP })).toBe(APP);
  });

  it("leaves events.app_id NULL when the grant carries no app", async () => {
    expect(await emit({ permissions: ["*"] })).toBeNull();
  });

  it("leaves events.app_id NULL when the write carries no grant", async () => {
    expect(await emit(null)).toBeNull();
  });

  it("an app LIFECYCLE event (no app key on the request) lands on the app's timeline via explicit appId", async () => {
    const subjectId = randomUUID();
    await auditLog({
      subjectType: "app",
      action: "issue_key",
      phase: "completed",
      subjectId,
      userId: "human-1",
      workspaceId: null,
      appId: APP,
    });
    const { rows } = await h.client!.query<{
      app_id: string | null;
      type: string;
    }>("SELECT app_id, type FROM events WHERE subject_id = $1", [subjectId]);
    expect(rows).toEqual([{ app_id: APP, type: "app.issue_key.completed" }]);
  });

  it("SynapEventSchema does NOT strip appId (the silent-drop trap)", () => {
    const parsed = SynapEventSchema.parse({
      id: randomUUID(),
      version: "v1",
      type: "entity.create.completed",
      userId: "human-1",
      data: {},
      source: "api",
      timestamp: new Date(),
      appId: APP,
    });
    expect(parsed.appId).toBe(APP);
  });
});
