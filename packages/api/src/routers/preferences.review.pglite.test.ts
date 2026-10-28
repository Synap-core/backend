/**
 * `preferences.updateReview` on PGlite through the REAL door (founder B-4):
 * it saves `uiPreferences.review` and MERGES — the rest of `uiPreferences`
 * (rail pins, view modes, feed preferences) survives — and the schema keeps
 * the key (the zod schema drops unknown keys, which is how a saved choice
 * would silently vanish).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig } from "drizzle-orm/pg-core";
import { syncGeneration, userPreferences, users } from "@synap/database/schema";
import { preferencesRouter } from "./preferences.js";

const U = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "ui_preferences"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const as = (userId: string) =>
  preferencesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
    db: h.db,
  } as never);

beforeAll(async () => {
  // `syncGeneration`: the mutation middleware's replica guard reads it (an
  // empty table = this pod is not a read-only replica).
  for (const t of [users, userPreferences, syncGeneration])
    await h.client!.exec(ddlFor(t));
  await h.client!.query(`insert into users (id, email) values ($1,$2)`, [
    U,
    `${U}@x.io`,
  ]);
  await as(U).updateViewMode({ context: "entities", mode: "table" });
});

describe("preferences.updateReview", () => {
  it("saves the review choice and keeps everything else in uiPreferences", async () => {
    await as(U).updateReview({
      groupBy: "work",
      layouts: { knowledge: "list" },
    });
    const { rows } = await h.client!.query<{ ui: Record<string, unknown> }>(
      `select ui_preferences as ui from user_preferences where user_id = $1`,
      [U]
    );
    expect(rows[0]?.ui.review).toEqual({
      groupBy: "work",
      layouts: { knowledge: "list" },
    });
    expect(rows[0]?.ui.viewModes).toEqual({ entities: "table" });
  });

  it("refuses a grouping or a layout nobody knows", async () => {
    await expect(
      as(U).updateReview({ groupBy: "mood" } as never)
    ).rejects.toThrow();
    await expect(
      as(U).updateReview({
        groupBy: "package",
        layouts: { knowledge: "carousel" },
      } as never)
    ).rejects.toThrow();
  });
});
