/**
 * F2 (plan v5, lane be-context) — `resolveClientOpenSession`, on PGlite: the
 * open sessions a conversation STARTED, never its auto-opened receipt, never a
 * guess among several, never "none" on a failed read.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { resolveClientOpenSession } from "../resolve-work-session.js";

const USER = "user-1";
const ONE = "key:k1|conv:claude-code:aaa";
const MANY = "key:k1|conv:claude-code:bbb";
const NONE = "key:k1|conv:claude-code:ccc";
const STALE = "key:k1|conv:claude-code:ddd";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = t.endsWith("[]") && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(
  clientKey: string,
  opts: { status?: string; autoOpened?: boolean; user?: string; title?: string }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'work', $3, $4, '[]'::jsonb, $5::jsonb, now(), now(), now())`,
    [
      id,
      opts.user ?? USER,
      opts.title ?? null,
      opts.status ?? "active",
      JSON.stringify({
        clientKey,
        ...(opts.autoOpened ? { autoOpened: true } : {}),
      }),
    ]
  );
  return id;
}

let mine: string;
let quiet: string;
beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  mine = await session(ONE, { title: "Work map" });
  // Same conversation, but not candidates: its receipt, a closed one, a
  // scheduled one, and another user's row with the same key.
  await session(ONE, { autoOpened: true });
  await session(ONE, { status: "closed" });
  await session(ONE, { status: "scheduled" });
  await session(ONE, { user: "user-2" });
  await session(MANY, { title: "First" });
  await session(MANY, { title: "Second", status: "paused" });
  await session(NONE, { autoOpened: true });
  quiet = await session(STALE, { title: "Gone quiet", status: "stale" });
  await session(STALE, { autoOpened: true, status: "stale" });
});

describe("resolveClientOpenSession (F2)", () => {
  it("exactly one open session this conversation started: that one", async () => {
    expect(
      await resolveClientOpenSession({ userId: USER, clientKey: ONE })
    ).toEqual({ status: "one", sessionId: mine, title: "Work map" });
  });

  it("several: lists them with the exact count, guesses none", async () => {
    const r = await resolveClientOpenSession({ userId: USER, clientKey: MANY });
    expect(r).toMatchObject({ status: "several", count: 2 });
    expect(
      r.status === "several" && r.sessions.map((s) => s.title).sort()
    ).toEqual(["First", "Second"]);
  });

  it("only a receipt (auto-opened): none — a PR is never recorded on a receipt", async () => {
    expect(
      await resolveClientOpenSession({ userId: USER, clientKey: NONE })
    ).toEqual({ status: "none" });
  });

  it("no open session but a STALE one it started: stale names it (never 'none'), never its receipt", async () => {
    const r = await resolveClientOpenSession({
      userId: USER,
      clientKey: STALE,
    });
    expect(r).toMatchObject({ status: "stale" });
    expect(r.status === "stale" && r.sessions.map((s) => s.id)).toEqual([
      quiet,
    ]);
  });

  it.each([
    ["a key shared by several conversations", "key:k1"],
    ["a per-call run", "key:k1|call:xyz"],
    ["no client at all", null],
  ])("%s: no_client, never a guess", async (_name, clientKey) => {
    expect(await resolveClientOpenSession({ userId: USER, clientKey })).toEqual(
      { status: "no_client" }
    );
  });

  it("a FAILED read is unavailable, never none", async () => {
    await h.client!.exec(`alter table focus_sessions rename to fs_gone`);
    try {
      expect(
        await resolveClientOpenSession({ userId: USER, clientKey: ONE })
      ).toEqual({ status: "unavailable" });
    } finally {
      await h.client!.exec(`alter table fs_gone rename to focus_sessions`);
    }
  });
});
