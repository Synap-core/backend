/**
 * `apiKeys.setGrants` — a key's owner, signed in, replaces what the key may
 * touch — through the REAL procedure on PGlite (every @synap/database table).
 * Stubbed: the db handle, audit + side-effects.
 *
 * Pinned:
 *   - a narrowing refuses at once: the grant the next request resolves
 *     (`resolveForKey`, read per request) denies the write it used to allow;
 *   - the set is REPLACED, never added to;
 *   - a non-owner is refused, a key cannot reshape itself (no session), and an
 *     app's key is changed on the app's page.
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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { GrantRepository } from "@synap/database";
import { apiKeysRouter } from "./api-keys.js";
import { grantWriteDenial } from "../utils/grant-write-check.js";

const HUMAN = "human-setgrants";
const OTHER = "someone-else";
const WS = "33333333-3333-4333-8333-333333333333";

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

const session = { identity: { id: HUMAN } };
const asOwner = () =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: HUMAN,
    session,
  } as never);
const asUser = (userId: string, extra: Record<string, unknown> = {}) =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    session: { identity: { id: userId } },
    ...extra,
  } as never);

const repo = () =>
  new GrantRepository(h.db as ConstructorParameters<typeof GrantRepository>[0]);

async function addKey(): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into api_keys
       (id, user_id, key_name, key_prefix, key_hash, key_type, scope,
        is_active, usage_count, created_at)
     values ($1, $2, 'Notes sync', 'synap_user_', $3, 'user_pat',
        '{hub-protocol.read,hub-protocol.write}', true, 0, now())`,
    [id, HUMAN, `hash-${id}`]
  );
  return id;
}

const grantInput = (
  apiKeyId: string,
  permissions: string[],
  clientId?: string
) => ({
  apiKeyId,
  principalUserId: HUMAN,
  onBehalfOf: HUMAN,
  permissions,
  workspaceIds: [WS],
  expiresAt: null,
  createdBy: HUMAN,
  clientId: clientId ?? null,
});

const createNote = {
  subjectType: "entity",
  action: "create",
  workspaceId: WS,
  data: { profileSlug: "note" },
};

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

describe("apiKeys.setGrants", () => {
  it("a narrowing refuses at once — the next request's grant denies the write", async () => {
    const id = await addKey();
    await repo().attach(grantInput(id, ["entity.note.*"]));
    expect(
      await grantWriteDenial(createNote, (await repo().resolveForKey(id))!)
    ).toBeNull();

    const res = await asOwner().setGrants({
      keyId: id,
      grants: [{ permissions: ["entity.note.read"], workspaceIds: [WS] }],
    });

    expect(res.access).toBe("granted");
    expect(res.grants.map((g) => g.permissions)).toEqual([
      ["entity.note.read"],
    ]);
    expect(
      await grantWriteDenial(createNote, (await repo().resolveForKey(id))!)
    ).toMatch(/does not allow "entity.note.create"/);
  });

  it("replaces the set — the previous grants end", async () => {
    const id = await addKey();
    await repo().attachMany([
      grantInput(id, ["entity.note.read"]),
      grantInput(id, ["entity.person.read"]),
    ]);
    await asOwner().setGrants({
      keyId: id,
      grants: [{ permissions: ["document.read"] }],
    });
    expect((await repo().resolveForKey(id))?.scopes).toEqual([
      {
        permissions: ["document.read"],
        workspaceIds: null,
        projectIds: null,
        entityIds: null,
      },
    ]);
  });

  it("a non-owner is refused and nothing changes", async () => {
    const id = await addKey();
    await repo().attach(grantInput(id, ["entity.note.read"]));
    await expect(
      asUser(OTHER).setGrants({ keyId: id, grants: [{ permissions: ["*"] }] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await repo().resolveForKey(id))?.scopes[0].permissions).toEqual([
      "entity.note.read",
    ]);
  });

  it("a key cannot reshape itself — no signed-in session, no change", async () => {
    const id = await addKey();
    await repo().attach(grantInput(id, ["entity.note.read"]));
    const noSession = apiKeysRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: HUMAN,
    } as never);
    await expect(
      noSession.setGrants({ keyId: id, grants: [{ permissions: ["*"] }] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      asUser(HUMAN, { keyType: "user_pat" }).setGrants({
        keyId: id,
        grants: [{ permissions: ["*"] }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await repo().resolveForKey(id))?.scopes[0].permissions).toEqual([
      "entity.note.read",
    ]);
  });

  it("an app's key is changed on the app's page", async () => {
    const id = await addKey();
    await repo().attach(
      grantInput(id, ["entity.note.read"], "app_0123456789abcdef")
    );
    await expect(
      asOwner().setGrants({ keyId: id, grants: [{ permissions: ["*"] }] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a revoked key has nothing to change", async () => {
    const id = await addKey();
    await h.client!.query(
      `update api_keys set is_active = false, revoked_at = now() where id = $1`,
      [id]
    );
    await expect(
      asOwner().setGrants({
        keyId: id,
        grants: [{ permissions: ["entity.note.read"] }],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await repo().resolveForKey(id)).toBeNull();
  });

  it("the key list names who holds each key — the door to its holder page", async () => {
    const id = await addKey();
    const row = (await asOwner().list()).find((k) => k.id === id);
    expect(row?.holderUserId).toBe(HUMAN);
  });
});
