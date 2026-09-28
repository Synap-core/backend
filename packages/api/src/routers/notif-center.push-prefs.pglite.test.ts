/**
 * Notification settings doors (W8 review):
 *   - an AGENT key cannot change how the person is interrupted —
 *     `setPushPrefs` and `updatePrefs` both refuse it, writing nothing;
 *   - the push-prefs write is ONE upsert on the partial unique index (0290):
 *     concurrent first writes leave exactly one pod-wide row, and merge.
 *
 * Real: the router doors, `writePushPrefs`, the unique index. Tables: every
 * `@synap/database` table (derived), plus the 0290 index by hand (the derived
 * DDL carries no indexes).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
        notificationPreferences: actual.notificationPreferences as never,
        workspaceMembers: actual.workspaceMembers as never,
        workspaces: actual.workspaces as never,
      },
    }),
  };
});
vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import { getTableConfig, type PgTable, PgTable as PgTableClass } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as database from "@synap/database";
import { notifCenterRouter } from "./notif-center.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
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

const caller = (agentUserId?: string) =>
  notifCenterRouter.createCaller({
    db: database.db,
    authenticated: true,
    userId: USER,
    workspaceId: WS,
    ...(agentUserId ? { agentUserId } : {}),
  } as never);

const podRows = () =>
  q<{ push_prefs: unknown; routing_rules: unknown }>(
    `select push_prefs, routing_rules from notification_preferences where user_id = $1 and workspace_id is null`,
    [USER]
  ).then((r) => r.rows);

describe("notification settings doors", () => {
  beforeAll(async () => {
    const seen = new Set<string>();
    for (const t of Object.values(database)) {
      if (!is(t, PgTableClass)) continue;
      const name = getTableConfig(t as PgTable).name;
      if (seen.has(name)) continue;
      seen.add(name);
      await h.client!.exec(ddlFor(t as PgTable));
    }
    expect(seen.size).toBeGreaterThan(50);
    await h.client!.exec(
      `alter table notification_preferences alter column enabled set default true;
       alter table notification_preferences alter column push_prefs set default '{}'::jsonb;
       create unique index notif_prefs_user_pod_unique on notification_preferences (user_id) where workspace_id is null;`
    );
    await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [WS, USER]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), WS, USER]
    );
  }, 120_000);

  beforeEach(async () => {
    await q(`delete from notification_preferences`);
  });

  it("an agent key cannot set push categories — nothing is written", async () => {
    await expect(
      caller(AGENT).setPushPrefs({ categories: { mention: false } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await podRows()).toHaveLength(0);
  });

  it("an agent key cannot update routing rules — nothing is written", async () => {
    await expect(
      caller(AGENT).updatePrefs({ routingRules: { "proposal.created": "all" } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await podRows()).toHaveLength(0);
  });

  it("non-vacuity: the person's own write lands", async () => {
    const out = await caller().setPushPrefs({ categories: { mention: false } });
    expect(out.categories.find((c) => c.category === "mention")).toMatchObject({
      enabled: false,
      explicit: true,
    });
    await caller().updatePrefs({ routingRules: { "chat.mention": "in_app" } });
    expect(await podRows()).toHaveLength(1);
  });

  it("concurrent FIRST writes leave ONE pod-wide row, with both categories merged", async () => {
    await Promise.all([
      caller().setPushPrefs({ categories: { mention: false } }),
      caller().setPushPrefs({ categories: { system: true } }),
    ]);
    const rows = await podRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.push_prefs).toEqual({
      categories: { mention: false, system: true },
    });
  });
});
