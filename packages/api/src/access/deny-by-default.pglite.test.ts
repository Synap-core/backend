/**
 * P5 — deny by default, driven end to end on PGlite.
 *
 * Two keys:
 *  - BACKFILLED existed before the flip; migration 0318 (the real SQL file)
 *    gave it an explicit `*` "Full access (before limits)" grant;
 *  - NEVER was minted after it with no grant row (a door that forgot).
 *
 * Through the real chain — `GrantRepository.resolveForKey` (what every
 * key-auth door enters) → `checkPermissionOrPropose` (write gate),
 * `keyGrantReadClause` (read floor), `isFencedGrant` (door fence) and
 * `assertMayDecideProposal` (decision gate):
 *  - NEVER is refused writes, reads nothing, is fenced and may not decide;
 *  - BACKFILLED keeps working exactly as an unbounded key did.
 * The BACKFILLED rows rule out a "deny every key" fix; the NEVER rows rule out
 * the legacy `null` = full reading.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
import { keyGrantReadClause } from "./grant-read.js";
import { isFencedGrant } from "./grant-door-fence.js";
import { assertMayDecideProposal } from "../routers/proposals/review-authority.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0318 = readFileSync(
  resolve(
    HERE,
    "../../../database/migrations/0318_grants_backfill_full_access.sql"
  ),
  "utf8"
);

const WS = randomUUID();
const NOTE = randomUUID();
const BACKFILLED = randomUUID();
const NEVER = randomUUID();

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
    const def = c.name === "created_at" ? " default now()" : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const insertKey = (id: string) =>
  h.client!.query(
    `insert into api_keys (id, user_id, key_name, key_prefix, key_hash, scope, is_active)
     values ($1, 'human-1', 'k', 'synap_user_', $2, '{hub-protocol.read,hub-protocol.write}', true)`,
    [id, `hash-${id}`]
  );

let never: KeyGrant;
let backfilled: KeyGrant;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `insert into entities (id, type, user_id, workspace_id) values ($1, 'note', 'human-1', $2)`,
    [NOTE, WS]
  );
  await insertKey(BACKFILLED);
  await h.client!.exec(M0318);
  await insertKey(NEVER);
  const repo = new GrantRepository(h.db as never);
  never = await repo.resolveForKey(NEVER);
  backfilled = await repo.resolveForKey(BACKFILLED);
});

const createNote = (grant: KeyGrant) =>
  runWithGrant(grant, () =>
    checkPermissionOrPropose({
      userId: "human-1",
      workspaceId: WS,
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "note", title: "n" },
    } as Parameters<typeof checkPermissionOrPropose>[0])
  ).catch((e: unknown) => ({ thrown: String(e) }));

const grantDenied = (r: unknown) =>
  /grant does not allow/.test((r as { reason?: string }).reason ?? "");

const visible = async (grant: KeyGrant) => {
  const clause = keyGrantReadClause(schema.entities, grant);
  const rows = await (h.db as any)
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(clause);
  return rows.map((r: { id: string }) => r.id);
};

describe("a never-granted key touches nothing (P5)", () => {
  it("resolves to one deny-all scope, never null", () => {
    expect(never).toEqual({ scopes: [{ permissions: [] }], clientId: null });
  });

  it("is refused a write by the grant rung", async () => {
    expect(grantDenied(await createNote(never))).toBe(true);
  });

  it("reads nothing", async () => {
    expect(await visible(never)).toEqual([]);
  });

  it("is fenced at the doors and may not decide a proposal", () => {
    expect(isFencedGrant(never)).toBe(true);
    expect(() => assertMayDecideProposal("approve", "approve", never)).toThrow(
      /may not approve/
    );
    expect(() => assertMayDecideProposal("reject", "reject", never)).toThrow();
  });
});

describe("the backfilled key keeps working (`*`)", () => {
  it("resolves to the explicit Full access grant", () => {
    expect(backfilled.scopes).toEqual([
      {
        permissions: ["*"],
        workspaceIds: null,
        projectIds: null,
        entityIds: null,
      },
    ]);
  });

  it("is not grant-denied a write, and reads what it did before", async () => {
    const r = await createNote(backfilled);
    expect(grantDenied(r)).toBe(false);
    // Past the grant rung — not a thrown error read as "not denied".
    expect((r as { reason?: string }).reason).toMatch(/not a member/);
    expect(await visible(backfilled)).toEqual([NOTE]);
  });

  it("is unfenced and may decide", () => {
    expect(isFencedGrant(backfilled)).toBe(false);
    expect(() =>
      assertMayDecideProposal("approve", "approve", backfilled)
    ).not.toThrow();
  });
});
