/**
 * A key's grants follow it through a rotation, and the key lists say what it
 * may touch — through the REAL `apiKeys.rotate` / `apiKeys.list` /
 * `apiKeys.listForWorkspace` procedures on PGlite (every @synap/database
 * table). Stubbed: the db handle, the governance gate, audit + side-effects.
 *
 * Pinned:
 *   - rotation: the new key resolves to EXACTLY the old key's bound, and the
 *     old key's grants are revoked. An ungranted new key would do everything
 *     its scopes allow — the rotation would be a widening.
 *   - a key whose grants all ended stays deny-all after rotation, and a
 *     never-granted key stays ungranted — which is deny-all too (P5).
 *   - lists: an expired grant is not shown as live; two live grants are both
 *     returned; a key whose grants all ended reads `access: 'ended'`.
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

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
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

const HUMAN = "human-rotate";
const WS = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;

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

const caller = () =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: HUMAN,
  } as never);

const wsCaller = () =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: HUMAN,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

const repo = () =>
  new GrantRepository(h.db as ConstructorParameters<typeof GrantRepository>[0]);

async function addKey(): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into api_keys
       (id, user_id, key_name, key_prefix, key_hash, key_type, scope,
        is_active, usage_count, workspace_id, created_at)
     values ($1, $2, 'Portfolio site', 'synap_user_', $3, 'user_pat',
        '{hub-protocol.read,hub-protocol.write}', true, 0, $4, now())`,
    [id, HUMAN, `hash-${id}`, WS]
  );
  return id;
}

const grantInput = (
  apiKeyId: string,
  over: Partial<Parameters<GrantRepository["attach"]>[0]> = {}
) => ({
  apiKeyId,
  principalUserId: HUMAN,
  onBehalfOf: HUMAN,
  permissions: ["entity.note.read"],
  expiresAt: null,
  createdBy: HUMAN,
  ...over,
});

const sortScopes = <T extends { permissions: readonly string[] }>(
  scopes: readonly T[]
) =>
  [...scopes].sort((a, b) =>
    a.permissions.join().localeCompare(b.permissions.join())
  );

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // listForWorkspace sits behind workspace membership.
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, HUMAN]
  );
});

describe("apiKeys.rotate — the grant follows the key", () => {
  it("the new key resolves to exactly the old key's bound; the old grants are revoked", async () => {
    const oldId = await addKey();
    await repo().attachMany([
      grantInput(oldId, {
        permissions: ["entity.note.read"],
        workspaceIds: [WS],
        label: "Notes",
        clientId: "app-1",
        expiresAt: new Date(Date.now() + 30 * DAY),
      }),
      grantInput(oldId, {
        permissions: ["entity.person.create"],
        clientId: "app-1",
      }),
    ]);
    const before = await repo().resolveForKey(oldId);

    const rotated = await caller().rotate({ keyId: oldId });
    const after = await repo().resolveForKey(rotated.id);

    expect(after).not.toBeNull();
    expect(sortScopes(after!.scopes)).toEqual(sortScopes(before!.scopes));
    expect(after!.clientId).toBe("app-1");
    // The rotated-away key's grants end with it.
    expect(await repo().resolveForKey(oldId)).toEqual({
      scopes: [{ permissions: [] }],
      clientId: "app-1",
    });
    const { rows } = await h.client!.query<{ label: string | null }>(
      `select label from grants where api_key_id = $1 and revoked_at is null`,
      [rotated.id]
    );
    expect(rows.map((r) => r.label).sort()).toEqual(["Notes", null].sort());
  });

  it("a key whose grants all ended stays deny-all — never ungranted", async () => {
    const oldId = await addKey();
    await repo().attach(grantInput(oldId));
    await repo().revokeForKeys([oldId], HUMAN);

    const rotated = await caller().rotate({ keyId: oldId });

    expect(await repo().resolveForKey(rotated.id)).toEqual({
      scopes: [{ permissions: [] }],
      clientId: null,
    });
  });

  it("an expired-only key stays deny-all", async () => {
    const oldId = await addKey();
    await repo().attach(
      grantInput(oldId, { expiresAt: new Date(Date.now() - DAY) })
    );

    const rotated = await caller().rotate({ keyId: oldId });

    expect((await repo().resolveForKey(rotated.id))?.scopes).toEqual([
      { permissions: [] },
    ]);
  });

  // P5 — rotation never turns "no access" into access.
  it("a never-granted key stays ungranted: deny-all, before and after", async () => {
    const oldId = await addKey();
    expect(await repo().resolveForKey(oldId)).toEqual({
      scopes: [{ permissions: [] }],
      clientId: null,
    });
    const rotated = await caller().rotate({ keyId: oldId });
    expect(await repo().resolveForKey(rotated.id)).toEqual({
      scopes: [{ permissions: [] }],
      clientId: null,
    });
  });
});

describe("key lists say what a key may touch", () => {
  const listed = async (keyId: string) => {
    const [mine, ws] = await Promise.all([
      caller().list(),
      wsCaller().listForWorkspace(),
    ]);
    const a = mine.find((k) => k.id === keyId)!;
    const b = ws.find((k) => k.id === keyId)!;
    // Both lists read the same door, so they must agree.
    expect({ access: b.access, grants: b.grants, grant: b.grant }).toEqual({
      access: a.access,
      grants: a.grants,
      grant: a.grant,
    });
    return a;
  };

  it("two live grants are both returned", async () => {
    const id = await addKey();
    await repo().attachMany([
      grantInput(id, { permissions: ["entity.note.read"] }),
      grantInput(id, { permissions: ["entity.person.create"] }),
    ]);
    const key = await listed(id);
    expect(key.access).toBe("granted");
    expect(key.grants.map((g) => g.permissions).sort()).toEqual([
      ["entity.note.read"],
      ["entity.person.create"],
    ]);
  });

  it("an expired grant is not shown as live", async () => {
    const id = await addKey();
    await repo().attach(
      grantInput(id, { expiresAt: new Date(Date.now() - DAY) })
    );
    const key = await listed(id);
    expect(key.grants).toEqual([]);
    expect(key.grant).toBeNull();
    expect(key.access).toBe("ended");
  });

  it("a key whose grants were all revoked reads 'ended', not ungranted", async () => {
    const id = await addKey();
    await repo().attach(grantInput(id));
    await repo().revokeForKeys([id], HUMAN);
    const key = await listed(id);
    expect(key.access).toBe("ended");
    expect(key.grants).toEqual([]);
  });

  it("a key that never had a grant reads 'ungranted'", async () => {
    const id = await addKey();
    const key = await listed(id);
    expect(key.access).toBe("ungranted");
    expect(key.grant).toBeNull();
  });
});
