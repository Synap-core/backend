/**
 * REAL-POSTGRES (PGlite) test for the owner-floored revocation door.
 *
 * This proves the CRITICAL security property that `setStatusForUser` CANNOT
 * flip another user's account. The prior regression deleted this door and
 * repointed user-driven paths at `updateStatus` (which matches on
 * (externalId, provider) ALONE — a push token is guessable, so that shape
 * would let a caller revoke ANY user's device).
 *
 * This test creates a `messaging_accounts` row owned by user A, calls the door
 * as user B with the same (provider, externalId), and asserts NOTHING was
 * changed. That is the reachability assertion this regression needs, and it is
 * the assertion that must fail if someone removes the `user_id` predicate again.
 *
 * Real: the `setStatusForUser` door, the (user_id, provider, external_id)
 * unique index, and side-effect emission. Tables are created from Drizzle
 * definitions. `emitSideEffects` is stubbed (fire-and-forget audit).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        messagingAccounts: actual.messagingAccounts as never,
      },
    }),
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: vi.fn(async () => undefined) };
});

import { getTableConfig, type PgTable, PgTable as PgTableClass } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as database from "@synap/database";
import { MessagingAccountService } from "../../services/messaging-account-service.js";
import { MESSAGING_ACCOUNT_PROVIDER_EXPO } from "@synap/database";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "ExponentPushToken[shared-guessable-token]";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "id" && type === "uuid"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

describe("setStatusForUser — owner floor (security regression guard)", () => {
  beforeAll(async () => {
    const seen = new Set<string>();
    for (const t of Object.values(database)) {
      if (!is(t, PgTableClass)) continue;
      const name = getTableConfig(t as PgTable).name;
      if (seen.has(name)) continue;
      seen.add(name);
      await h.client!.exec(ddlFor(t as PgTable));
    }
    // messaging_accounts needs its unique index (the DDL above doesn't include indexes)
    await h.client!.exec(`
      create unique index if not exists idx_messaging_accounts_user_provider_external
      on messaging_accounts (user_id, provider, external_id);
    `);
  }, 120_000);

  afterAll(async () => {
    // PGlite's close() is not on our typed client surface; vitest tears the
    // in-process WASM down on its own. The beforeAll table creation is what
    // matters here — no external connections to release.
  });

  beforeEach(async () => {
    await q(`delete from messaging_accounts`);
  });

  it("REVOKES the caller's own device — returns true and flips status", async () => {
    await q(
      `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, metadata)
       values ($1, $2, $3, $4, 'User A iPhone', 'connected', '{}')`,
      [randomUUID(), USER_A, MESSAGING_ACCOUNT_PROVIDER_EXPO, TOKEN]
    );

    const revoked = await MessagingAccountService.setStatusForUser({
      userId: USER_A,
      provider: MESSAGING_ACCOUNT_PROVIDER_EXPO,
      externalId: TOKEN,
      status: "disconnected",
    });

    expect(revoked).toBe(true);

    const row = await q<{ status: string }>(
      `select status from messaging_accounts where user_id = $1 and provider = $2 and external_id = $3`,
      [USER_A, MESSAGING_ACCOUNT_PROVIDER_EXPO, TOKEN]
    );
    expect(row.rows[0]!.status).toBe("disconnected");
  });

  it("DOES NOT REVOKE another user's device — returns false and leaves status untouched", async () => {
    await q(
      `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, metadata)
       values ($1, $2, $3, $4, 'User A iPhone', 'connected', '{}')`,
      [randomUUID(), USER_A, MESSAGING_ACCOUNT_PROVIDER_EXPO, TOKEN]
    );

    // Call the door AS USER B with the SAME (provider, externalId) —
    // this is the exact shape a malicious caller would try.
    const revoked = await MessagingAccountService.setStatusForUser({
      userId: USER_B,
      provider: MESSAGING_ACCOUNT_PROVIDER_EXPO,
      externalId: TOKEN,
      status: "disconnected",
    });

    // Must return false (no row touched) — not true, not throw
    expect(revoked).toBe(false);

    // User A's row MUST remain 'connected'
    const row = await q<{ status: string }>(
      `select status from messaging_accounts where user_id = $1 and provider = $2 and external_id = $3`,
      [USER_A, MESSAGING_ACCOUNT_PROVIDER_EXPO, TOKEN]
    );
    expect(row.rows[0]!.status).toBe("connected");

    // User B must NOT have a row created (no upsert behavior here)
    const bRows = await q(
      `select * from messaging_accounts where user_id = $1`,
      [USER_B]
    );
    expect(bRows.rows).toHaveLength(0);
  });

  it("non-vacuity: calling as user B with user B's OWN token WORKS", async () => {
    const B_TOKEN = "ExponentPushToken[user-b-own-token]";
    await q(
      `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, metadata)
       values ($1, $2, $3, $4, 'User B iPhone', 'connected', '{}')`,
      [randomUUID(), USER_B, MESSAGING_ACCOUNT_PROVIDER_EXPO, B_TOKEN]
    );

    const revoked = await MessagingAccountService.setStatusForUser({
      userId: USER_B,
      provider: MESSAGING_ACCOUNT_PROVIDER_EXPO,
      externalId: B_TOKEN,
      status: "disconnected",
    });

    expect(revoked).toBe(true);

    const row = await q<{ status: string }>(
      `select status from messaging_accounts where user_id = $1 and provider = $2 and external_id = $3`,
      [USER_B, MESSAGING_ACCOUNT_PROVIDER_EXPO, B_TOKEN]
    );
    expect(row.rows[0]!.status).toBe("disconnected");
  });
});