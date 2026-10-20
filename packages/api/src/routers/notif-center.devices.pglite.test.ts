/**
 * A person's phones (`notifCenter.registerDevice` / `unregisterDevice` /
 * `revokeDevice` / `listDevices`):
 *   - a phone turned off from elsewhere (`revoked`) stays off through a plain
 *     re-register and a sign-out/sign-in; only `reenable` from that phone
 *     turns it back on;
 *   - revoke is floored on the caller: another person's phone (a pod admin
 *     included) and a missing one answer the same NOT_FOUND, writing nothing;
 *   - an agent key can neither add a phone nor turn one off;
 *   - the list never carries the token, and knows "this phone" only from it.
 *
 * Real: the router doors, `push-devices.ts`, the (user, provider, token)
 * unique index. Tables: every `@synap/database` table (derived), plus the
 * index and the column defaults by hand (the derived DDL carries neither).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

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
  return {
    ...actual,
    db: drizzle(client, {
      schema: { messagingAccounts: actual.messagingAccounts as never },
    }),
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import {
  getTableConfig,
  type PgTable,
  PgTable as PgTableClass,
} from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as database from "@synap/database";
import { notifCenterRouter } from "./notif-center.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "44444444-4444-4444-8444-444444444444";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PHONE = "ExponentPushToken[ada-phone]";
const OTHER_PHONE = "ExponentPushToken[bob-phone]";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId = USER, agentUserId?: string) =>
  notifCenterRouter.createCaller({
    db: database.db,
    authenticated: true,
    userId,
    ...(agentUserId ? { agentUserId } : {}),
  } as never);

type Row = {
  id: string;
  user_id: string;
  status: string;
  metadata: Record<string, unknown>;
};
const rows = () =>
  q<Row>(
    `select id, user_id, status, metadata from messaging_accounts order by user_id`
  ).then((r) => r.rows);
const rowOf = async (token: string) =>
  (
    await q<Row>(
      `select id, user_id, status, metadata from messaging_accounts where external_id = $1`,
      [token]
    )
  ).rows[0]!;

const register = (
  extra: { reenable?: boolean; everyLaunch?: boolean } = {},
  token = PHONE,
  userId = USER
) =>
  caller(userId).registerDevice({
    token,
    platform: "ios",
    deviceName: "Ada's iPhone",
    appVersion: "1.4.0",
    ...extra,
  });

describe("a person's phones", () => {
  beforeAll(async () => {
    const seen = new Set<string>();
    for (const t of Object.values(database)) {
      if (!is(t, PgTableClass)) continue;
      const name = getTableConfig(t as PgTable).name;
      if (seen.has(name)) continue;
      seen.add(name);
      await h.client!.exec(ddlFor(t as PgTable));
    }
    expect(seen.has("messaging_accounts")).toBe(true);
    await h.client!.exec(
      `alter table messaging_accounts alter column id set default gen_random_uuid()::text;
       alter table messaging_accounts alter column status set default 'connected';
       alter table messaging_accounts alter column display_name set default '';
       alter table messaging_accounts alter column metadata set default '{}'::jsonb;
       create unique index idx_messaging_accounts_user_provider_external
         on messaging_accounts (user_id, provider, external_id);`
    );
  }, 120_000);

  beforeEach(async () => {
    await q(`delete from messaging_accounts`);
  });

  it("registers a phone as connected, and a re-register reuses the row", async () => {
    const first = await register();
    expect(first).toMatchObject({ success: true, status: "connected" });
    const again = await register();
    expect(again.id).toBe(first.id);
    expect(await rows()).toHaveLength(1);
  });

  it("only an every-launch registration records last seen", async () => {
    await register();
    expect((await rowOf(PHONE)).metadata.lastSeenAt).toBeUndefined();
    await register({ everyLaunch: true });
    expect(typeof (await rowOf(PHONE)).metadata.lastSeenAt).toBe("string");
    // An app that stops registering on every launch loses the claim.
    await register();
    expect((await rowOf(PHONE)).metadata.lastSeenAt).toBeUndefined();
  });

  it("a phone turned off from elsewhere stays off through a plain re-register", async () => {
    const { id } = await register({ everyLaunch: true });
    await expect(caller().revokeDevice({ id })).resolves.toEqual({
      id,
      status: "revoked",
    });
    const revokedAt = (await rowOf(PHONE)).metadata.revokedAt;
    expect(typeof revokedAt).toBe("string");

    await expect(register({ everyLaunch: true })).resolves.toMatchObject({
      id,
      status: "revoked",
    });
    const row = await rowOf(PHONE);
    expect(row.status).toBe("revoked");
    expect(row.metadata.revokedAt).toBe(revokedAt);
    // Still a sighting: the phone is in use, just not getting pushes.
    expect(typeof row.metadata.lastSeenAt).toBe("string");
  });

  it("signing out and back in does not undo a turn-off from elsewhere", async () => {
    const { id } = await register();
    await caller().revokeDevice({ id });
    await expect(
      caller().unregisterDevice({ token: PHONE })
    ).resolves.toMatchObject({ revoked: true });
    expect((await rowOf(PHONE)).status).toBe("revoked");
    await expect(register()).resolves.toMatchObject({ status: "revoked" });
  });

  it("re-enable from that phone turns it back on and clears the turn-off", async () => {
    const { id } = await register();
    await caller().revokeDevice({ id });
    await expect(register({ reenable: true })).resolves.toMatchObject({
      id,
      status: "connected",
    });
    const row = await rowOf(PHONE);
    expect(row.status).toBe("connected");
    expect(row.metadata.revokedAt).toBeUndefined();
  });

  it("a signed-out phone comes back on its next registration", async () => {
    await register();
    await caller().unregisterDevice({ token: PHONE });
    expect((await rowOf(PHONE)).status).toBe("disconnected");
    await expect(register()).resolves.toMatchObject({ status: "connected" });
  });

  it("revoking twice keeps the first turn-off time", async () => {
    const { id } = await register();
    await caller().revokeDevice({ id });
    const first = (await rowOf(PHONE)).metadata.revokedAt;
    await expect(caller().revokeDevice({ id })).resolves.toEqual({
      id,
      status: "revoked",
    });
    expect((await rowOf(PHONE)).metadata.revokedAt).toBe(first);
  });

  it("refuses another person's phone exactly like a missing one, writing nothing", async () => {
    const theirs = await register({}, OTHER_PHONE, OTHER);
    const foreign = caller().revokeDevice({ id: theirs.id });
    await expect(foreign).rejects.toMatchObject({ code: "NOT_FOUND" });
    const missing = caller().revokeDevice({ id: "no-such-phone" });
    await expect(missing).rejects.toMatchObject({ code: "NOT_FOUND" });
    const messageOf = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: Error) => e.message
      );
    expect(await messageOf(foreign)).toBe(await messageOf(missing));
    expect((await rowOf(OTHER_PHONE)).status).toBe("connected");
  });

  it("an agent key cannot turn a phone off", async () => {
    const { id } = await register();
    await expect(
      caller(USER, AGENT).revokeDevice({ id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rowOf(PHONE)).status).toBe("connected");
  });

  it("an agent key cannot add a phone or turn one back on", async () => {
    await expect(
      caller(USER, AGENT).registerDevice({
        token: PHONE,
        platform: "android",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rows()).toHaveLength(0);

    const { id } = await register();
    await caller().revokeDevice({ id });
    await expect(
      caller(USER, AGENT).registerDevice({
        token: PHONE,
        platform: "ios",
        reenable: true,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rowOf(PHONE)).status).toBe("revoked");
  });

  it("lists only the caller's phones, never the token, and knows this phone by it", async () => {
    await register({ everyLaunch: true });
    await register({}, "ExponentPushToken[ada-tablet]");
    await register({}, OTHER_PHONE, OTHER);

    const all = await caller().listDevices();
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("ExponentPushToken");
    expect(all.every((d) => !d.isThisDevice)).toBe(true);

    const mine = await caller().listDevices({ token: PHONE });
    const me = mine.find((d) => d.isThisDevice)!;
    expect(me).toMatchObject({
      name: "Ada's iPhone",
      platform: "ios",
      appVersion: "1.4.0",
      status: "connected",
      revokedAt: null,
    });
    expect(typeof me.lastSeenAt).toBe("string");
    expect(mine.filter((d) => d.isThisDevice)).toHaveLength(1);

    // Another person's token names nothing in MY list.
    const probe = await caller().listDevices({ token: OTHER_PHONE });
    expect(probe.some((d) => d.isThisDevice)).toBe(false);
  });
});
