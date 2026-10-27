/**
 * F2 (plan v5, lane be-context) END TO END on PGlite: an `outcomes` write on
 * `synap_update_session` with NO `sessionId` — the PR hook's one call.
 *
 * Real: the MCP handler, the request's client key (`runWithClientKey`), the
 * resolver (`resolveClientOpenSession`), `resolveOutcomesUpdate` and
 * `updateFocusSession` writing the row. Stubbed: the governance membrane
 * (granted — its own suite), side-effect events, and the reply's nudge read
 * (`session-nudges` has its own suites).
 *
 *   - exactly one open session this conversation STARTED → the PR outcome
 *     lands on that row (and nowhere else), the reply says `inferred`;
 *   - several → refused with the list, NO row changes.
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
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../../services/focus-sessions/session-nudges.js", () => ({
  loadSessionNudges: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, runWithClientKey } from "@synap/database";

// `update-session` FIRST. Loaded through the handler instead, it is first
// evaluated inside the permission-check mock's own `importOriginal` (the real
// permission-check reaches it statically, via `satisfy-expected-output`), and
// its later `import()` of permission-check then resolves to the ORIGINAL: the
// real gate ran against PGlite (no `governance_rules`) and the write read
// "Permission check error" (as in `block-guidelines.test.ts`).
await import("../../../services/focus-sessions/update-session.js");
const { sessionHandlers } = await import("../handlers/session.js");

const USER = "user-1";
const ONE = "key:k1|conv:claude-code:one";
const MANY = "key:k1|conv:claude-code:many";
const PR = {
  key: "pr-backend-285",
  kind: "pull_request",
  label: "backend#285",
  ref: { url: "https://github.com/Synap-core/backend/pull/285" },
};

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
  opts: { status?: string; autoOpened?: boolean; title: string }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, criteria, agent_ids, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, '[]'::jsonb, '[]'::jsonb, '{}', $6::jsonb, 'agent', now(), now(), now())`,
    [
      id,
      USER,
      opts.title,
      opts.title,
      opts.status ?? "active",
      JSON.stringify({
        clientKey,
        ...(opts.autoOpened ? { autoOpened: true } : {}),
      }),
    ]
  );
  return id;
}

const slotsOf = async (id: string) =>
  (
    await q<{ expected_outputs: Array<Record<string, unknown>> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;

const call = (clientKey: string, args: Record<string, unknown>) =>
  runWithClientKey(clientKey, async () => {
    const res = (await sessionHandlers.synap_update_session!({
      toolName: "synap_update_session",
      args,
      userId: USER,
      apiKeyScopes: ["mcp.write", "mcp.read"],
      workspaceAccessible: false,
      caller: {} as never,
      lensCaller: {} as never,
    } as never)) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  });

let started: string;
let receipt: string;
let closed: string;
let manyA: string;
let manyB: string;

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  started = await session(ONE, { title: "Work map" });
  receipt = await session(ONE, { title: "Receipt", autoOpened: true });
  closed = await session(ONE, { title: "Old", status: "closed" });
  manyA = await session(MANY, { title: "First" });
  manyB = await session(MANY, { title: "Second" });
}, 120_000);

describe("update_session outcomes with no sessionId (F2), on PGlite", () => {
  it("one open session this conversation started: the PR outcome lands on it, and only there", async () => {
    const out = await call(ONE, { outcomes: [PR] });
    expect(out).toMatchObject({
      status: "updated",
      inferred: true,
      via: "client",
    });
    const slot = (await slotsOf(started)).find((s) => s.key === PR.key);
    expect(slot).toMatchObject({
      kind: "pull_request",
      ref: { url: PR.ref.url },
    });
    // Never on the conversation's receipt or its closed session.
    expect(await slotsOf(receipt)).toEqual([]);
    expect(await slotsOf(closed)).toEqual([]);
  });

  it("several open sessions: refused with the list, and no row changes", async () => {
    const out = await call(MANY, { outcomes: [PR] });
    expect(String(out.error)).toContain("NOTHING WAS CHANGED");
    expect(
      (out.sessions as Array<{ id: string }>).map((s) => s.id).sort()
    ).toEqual([manyA, manyB].sort());
    expect(await slotsOf(manyA)).toEqual([]);
    expect(await slotsOf(manyB)).toEqual([]);
  });
});
