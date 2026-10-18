/**
 * `applicationConnections.list` / `.get` — usage read from what the pod
 * already records (no new column), through the REAL router on PGlite.
 *
 * Pinned:
 *   - `lastUsedAt` is the newest access receipt of the connection's issuer,
 *     `peopleCount` the people linked through it; a connection whose issuer
 *     never acted reads null / 0;
 *   - `get` names the people (newest link first) and is NOT_FOUND for an
 *     unknown id; its `requestIds` are the app's asks through the same
 *     issuer, newest first — another app's or another issuer's are not;
 *   - both are pod-admin only.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  admins: new Set<string>(),
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
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { applicationConnectionsRouter } from "./application-connections.js";

const ADMIN = "human-admin";
const ANNA = "human-anna";
const BEN = "human-ben";
const USED_ISSUER = randomUUID();
const QUIET_ISSUER = randomUUID();
const USED = randomUUID();
const QUIET = randomUUID();
const SPACE = randomUUID();
const ASK_OLD = randomUUID();
const ASK_NEW = randomUUID();

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
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const caller = (userId: string) =>
  applicationConnectionsRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
  } as never);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  h.admins.add(ADMIN);
  for (const [id, name] of [
    [ADMIN, "Ada"],
    [ANNA, "Anna"],
    [BEN, "Ben"],
  ])
    await q(
      `insert into users (id, email, name, user_type) values ($1, $1 || '@x', $2, 'human')`,
      [id, name]
    );
  for (const [id, url] of [
    [USED_ISSUER, "https://landing.example"],
    [QUIET_ISSUER, "https://quiet.example"],
  ])
    await q(
      `insert into trusted_issuers (id, issuer_url, display_name, status) values ($1, $2, $2, 'approved')`,
      [id, url]
    );
  for (const [id, issuer, name] of [
    [USED, USED_ISSUER, "Synap Landing"],
    [QUIET, QUIET_ISSUER, "Quiet app"],
  ])
    await q(
      `insert into federated_application_connections
         (id, issuer_id, client_id, display_name, allowed_origins, allowed_callback_urls, allowed_scopes, status)
       values ($1, $2, $3, $4, '{https://app.example}', '{https://app.example/cb}', '{}', 'approved')`,
      [id, issuer, `client-${name}`, name]
    );
  await q(
    `insert into federated_identity_links (issuer_id, issuer_subject, user_id, linked_at)
     values ($1, 'sub-anna', $2, '2026-10-01T00:00:00Z'), ($1, 'sub-ben', $3, '2026-10-05T00:00:00Z')`,
    [USED_ISSUER, ANNA, BEN]
  );
  await q(
    `insert into federated_access_receipts (issuer_id, command_id, issuer_subject, user_id, scope_kind, workspace_id, role, applied_at)
     values ($1, 'c1', 'sub-anna', $2, 'workspace', $3, 'viewer', '2026-10-02T00:00:00Z'),
            ($1, 'c2', 'sub-ben', $4, 'workspace', $3, 'editor', '2026-10-09T12:00:00Z')`,
    [USED_ISSUER, ANNA, SPACE, BEN]
  );
  for (const [id, issuerUrl, clientId, at] of [
    [ASK_OLD, "https://landing.example", "client-Synap Landing", "2026-10-01"],
    [ASK_NEW, "https://landing.example", "client-Synap Landing", "2026-10-08"],
    [randomUUID(), "https://landing.example", "client-Other", "2026-10-09"],
    [
      randomUUID(),
      "https://quiet.example",
      "client-Synap Landing",
      "2026-10-09",
    ],
  ])
    await q(
      `insert into federated_application_connection_requests
         (id, issuer_url, issuer_subject, client_id, display_name, requested_origin, requested_callback_url,
          continuation_hash, redemption_hash, status, expires_at, created_at)
       values ($1::uuid, $2, 'sub', $3, 'x', 'https://app.example', 'https://app.example/cb', $1::text, $1::text, 'rejected', now(), $4)`,
      [id, issuerUrl, clientId, at]
    );
}, 120_000);

describe("applicationConnections.list — usage", () => {
  it("reads last use and people from the issuer's receipts and links", async () => {
    const { connections } = await caller(ADMIN).list();
    const used = connections.find((c) => c.id === USED)!;
    expect(used.lastUsedAt?.toISOString()).toBe("2026-10-09T12:00:00.000Z");
    expect(used.peopleCount).toBe(2);
    const quiet = connections.find((c) => c.id === QUIET)!;
    expect(quiet).toMatchObject({ lastUsedAt: null, peopleCount: 0 });
  });

  it("is pod-admin only", async () => {
    await expect(caller(ANNA).list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("applicationConnections.get", () => {
  it("names who uses it, newest link first", async () => {
    const one = await caller(ADMIN).get({ id: USED });
    expect(one).toMatchObject({
      displayName: "Synap Landing",
      issuerUrl: "https://landing.example",
      peopleCount: 2,
    });
    expect(one.people.map((p) => p.name)).toEqual(["Ben", "Anna"]);
  });

  it("lists its own asks, newest first, for its Activity", async () => {
    const one = await caller(ADMIN).get({ id: USED });
    expect(one.requestIds).toEqual([ASK_NEW, ASK_OLD]);
    const quiet = await caller(ADMIN).get({ id: QUIET });
    expect(quiet.requestIds).toEqual([]);
  });

  it("an unknown connection is NOT_FOUND; a member is refused", async () => {
    await expect(caller(ADMIN).get({ id: randomUUID() })).rejects.toMatchObject(
      { code: "NOT_FOUND" }
    );
    await expect(caller(BEN).get({ id: USED })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
