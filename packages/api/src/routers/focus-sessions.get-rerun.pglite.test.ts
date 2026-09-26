/**
 * `rerun: { available, reason? }` ARRIVES on the session read both rooms use —
 * driven through the REAL `focusSessions.get` procedure on PGlite, so the value
 * is proven on the wire shape (reachability), not merely declared.
 *
 * Real: the procedure (owner floor, participants projection, triage + kind),
 * `assessRerunAvailability` with the real `pgboss.job` + `chat_turns` reads.
 * Tables are generated from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `getParentSessionId(s)` — lineage lives on `@synap/database`'s own
 *    connection (the `links` walk); pinned to "no parent".
 *
 * NOT covered: the Hub `GET /focus-sessions/:id` projection (same function,
 * typecheck only).
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
      schema: { focusSessions: actual.focusSessions as never },
    }),
    getParentSessionId: async () => null,
    getParentSessionIds: async () => new Map(),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  proposals,
  users,
  chatTurns,
  workspaces,
  workspaceMembers,
  channels,
  channelMembers,
  podMembers,
  projectMembers,
} from "@synap/database";
import { focusSessionsRouter } from "./focus-sessions.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(opts: {
  status: string;
  withRun: boolean;
}): Promise<string> {
  const id = randomUUID();
  const metadata = opts.withRun
    ? {
        intake: { door: "capture" },
        run: {
          version: 1,
          sourceDocumentIds: [randomUUID()],
          guidelines: [],
          engine: "structure",
          model: "m",
          promptVersion: "p",
          updatedAt: "t",
        },
      }
    : {};
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
     values ($1, $2, 'Capture · notes', $3, $4::jsonb, now(), now())`,
    [id, USER, opts.status, JSON.stringify(metadata)]
  );
  return id;
}

const get = (id: string) =>
  focusSessionsRouter
    .createCaller({ db, authenticated: true, userId: USER } as never)
    .get({ id });

describe("focusSessions.get projects the rerun door's own availability", () => {
  beforeAll(async () => {
    // The participants projection floors proposals through workspace membership.
    for (const t of [
      focusSessions,
      proposals,
      users,
      chatTurns,
      workspaces,
      workspaceMembers,
      // The session read predicate's roster branch joins these (decision C).
      channels,
      channelMembers,
      podMembers,
      projectMembers,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`
    );
  });
  beforeEach(async () => {
    await h.client!.exec("delete from focus_sessions; delete from pgboss.job;");
  });

  it("an active intake run with nothing in flight reads available; a queued job flips it to in_flight", async () => {
    const id = await session({ status: "active", withRun: true });
    expect((await get(id)).rerun).toEqual({ available: true });

    await q(
      `insert into pgboss.job (name, state, data) values ('capture', 'created', $1::jsonb)`,
      [JSON.stringify({ userId: USER, sessionId: id })]
    );
    expect((await get(id)).rerun).toEqual({
      available: false,
      reason: "in_flight",
    });
  });

  it("a session with no stored sources reads no_manifest", async () => {
    const id = await session({ status: "closed", withRun: false });
    expect((await get(id)).rerun).toEqual({
      available: false,
      reason: "no_manifest",
    });
  });
});
