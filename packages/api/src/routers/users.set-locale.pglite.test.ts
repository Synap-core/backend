/**
 * `users.setLocale` on PGlite through the REAL door: it stores the caller's
 * language on THEIR row only, `users.me` reads it back, the input takes a
 * supported locale and nothing else, and a caller with no row gets NOT_FOUND
 * instead of a success that stored nothing.
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
import { syncGeneration, users } from "@synap/database/schema";
import { usersRouter } from "./users.js";

const ME = randomUUID();
const OTHER = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary ? " primary key" : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "locale"
          ? " default 'en'"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const as = (userId: string) =>
  usersRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
    db: h.db,
  } as never);

const localeOf = async (id: string) =>
  (
    await h.client!.query<{ locale: string }>(
      `select locale from users where id = $1`,
      [id]
    )
  ).rows[0]?.locale;

beforeAll(async () => {
  // `syncGeneration`: the mutation middleware's replica guard reads it (an
  // empty table = this pod is not a read-only replica).
  for (const t of [users, syncGeneration]) await h.client!.exec(ddlFor(t));
  for (const id of [ME, OTHER]) {
    await h.client!.query(`insert into users (id, email) values ($1, $2)`, [
      id,
      `${id}@x.io`,
    ]);
  }
});

describe("users.setLocale", () => {
  it("stores the caller's language, and users.me reads it back", async () => {
    expect(await localeOf(ME)).toBe("en");
    expect(await as(ME).setLocale({ locale: "fr" })).toEqual({
      locale: "fr",
    });
    expect(await localeOf(ME)).toBe("fr");
    expect((await as(ME).me()).locale).toBe("fr");

    await as(ME).setLocale({ locale: "en" });
    expect(await localeOf(ME)).toBe("en");
  });

  it("writes the caller's row only", async () => {
    await as(OTHER).setLocale({ locale: "fr" });
    expect(await localeOf(OTHER)).toBe("fr");
    expect(await localeOf(ME)).toBe("en");
  });

  it("refuses a locale Synap does not ship, and stores nothing", async () => {
    for (const locale of ["de", "fr-FR", "FR", "", "en-XA"]) {
      await expect(
        as(ME).setLocale({ locale } as never),
        `locale ${JSON.stringify(locale)}`
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await localeOf(ME)).toBe("en");
  });

  it("answers NOT_FOUND when the caller has no user row", async () => {
    const ghost = randomUUID();
    await expect(as(ghost).setLocale({ locale: "fr" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await localeOf(ghost)).toBeUndefined();
  });
});
