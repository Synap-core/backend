/**
 * `artifacts.list` (the desk's read) names an ENTITY artifact's kind.
 *
 * The desk card said "Entity" for every entity because the row carried only the
 * artifact kind. The read now attaches `entityProfile` (slug + display name +
 * icon) — through the caller's OWN entity floor, since `artifacts.create` does
 * not floor `refId`: an entity the caller cannot read gets no kind.
 *
 * Driven through the REAL procedure on PGlite; nothing hand-built downstream.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database";
import { artifactsRouter } from "./artifacts.js";

const USER = "user-1";
const STRANGER = "user-2";
const PROFILE = randomUUID();
const MINE = randomUUID(); // a decision the caller owns (profile row)
const BARE = randomUUID(); // a note with no profile row — slug from entities.type
const THEIRS = randomUUID(); // another user's entity — no kind may leak
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function artifact(kind: string, refId: string | null, title: string) {
  await q(
    `insert into artifacts (id, user_id, workspace_id, kind, ref_id, title, origin_kind, state, placement, props, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, 'agent', 'working', 'desk', '{}'::jsonb, now(), now())`,
    [randomUUID(), USER, kind, refId, title]
  );
}

beforeAll(async () => {
  // Every table the artifact + entity floors can reference.
  for (const value of Object.values(schema)) {
    try {
      getTableConfig(value as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(value as PgTable));
  }
  await q(`insert into users (id, email) values ($1, 'a@x'), ($2, 'b@x')`, [
    USER,
    STRANGER,
  ]);
  await q(
    `insert into profiles (id, slug, display_name, ui_hints) values ($1, 'decision', 'Decision', '{"icon":"Gavel"}'::jsonb)`,
    [PROFILE]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, title, type, profile_id) values
      ($1, $2, null, 'Go with Stripe', 'decision', $3),
      ($4, $2, null, 'Loose note', 'note', null),
      ($5, $6, null, 'Private', 'decision', $3)`,
    [MINE, USER, PROFILE, BARE, THEIRS, STRANGER]
  );
  await artifact("entity", MINE, "Go with Stripe");
  await artifact("entity", BARE, "Loose note");
  await artifact("entity", THEIRS, "Pointed at a stranger's entity");
  await artifact("url", "https://example.test", "A page");
});

describe("artifacts.list — an entity artifact names its KIND", () => {
  it("attaches the profile (slug, display name, icon) to the caller's own entities only", async () => {
    const rows = (await artifactsRouter
      .createCaller({ userId: USER, authenticated: true } as never)
      .list({})) as Array<{ refId: string | null; entityProfile?: unknown }>;
    const by = (refId: string) => rows.find((r) => r.refId === refId)!;
    // Non-vacuity: all four rows came back.
    expect(rows).toHaveLength(4);
    expect(by(MINE).entityProfile).toEqual({
      slug: "decision",
      displayName: "Decision",
      icon: "Gavel",
    });
    expect(by(BARE).entityProfile).toEqual({
      slug: "note",
      displayName: null,
      icon: null,
    });
    // The entity floor holds: a stranger's entity yields no kind.
    expect(by(THEIRS).entityProfile).toBeUndefined();
    expect(by("https://example.test").entityProfile).toBeUndefined();
  });
});
