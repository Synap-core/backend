/**
 * `readKeyDetail` — one key for the Keys page's panel, on PGlite with the real
 * tables it reads: only LIVE grants, with space and person names; usage folded
 * per day (failed = 4xx/5xx/429) and by client; the proposals the key filed
 * and the sessions it worked in (one row per session, latest first); nothing
 * from another key. Usage comes through the one usage door, stubbed here (its
 * own floor and parsing are tested in `usage/`).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  usageCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("./usage/read-usage.js", () => ({
  readUsageForCaller: async (_userId: string, req: Record<string, unknown>) => {
    h.usageCalls.push(req);
    return req.groupBy === "client"
      ? {
          retentionDays: 30,
          groups: [
            { client: "claude-code", calls: 40 },
            { client: "cli", calls: 2 },
          ],
        }
      : {
          retentionDays: 30,
          groups: [
            { day: "2026-10-28", outcome: "2xx", calls: 10 },
            { day: "2026-10-28", outcome: "4xx", calls: 2 },
            { day: "2026-10-27", outcome: "2xx", calls: 5 },
            { day: "2026-10-27", outcome: "429", calls: 1 },
          ],
        };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  apiKeys,
  focusSessions,
  grants,
  proposals,
  sessionRunners,
  users,
  workspaces,
} from "@synap/database/schema";
import { readKeyDetail } from "./key-detail.js";

const KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const S1 = "44444444-4444-4444-8444-444444444444";
const S2 = "55555555-5555-4555-8555-555555555555";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  for (const t of [
    apiKeys,
    grants,
    proposals,
    sessionRunners,
    focusSessions,
    users,
    workspaces,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(`insert into users (id, name) values ('person-1', 'Antoine')`);
  await q(`insert into workspaces (id, name) values ($1, 'Builder')`, [WS]);
  await q(
    `insert into api_keys (id, key_name) values ($1, 'mine'), ($2, 'other')`,
    [KEY, OTHER_KEY]
  );
  // One live grant pinned to a space, one revoked, one on another key.
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, label, created_by, created_at, revoked_at) values
      (gen_random_uuid(), $1, 'agent-1', 'person-1', '{entity.post.create,entity.read}', ARRAY[$3]::uuid[], 'Posting', 'person-1', now(), null),
      (gen_random_uuid(), $1, 'agent-1', 'person-1', '{*}', null, 'old', 'person-1', now() - interval '9 days', now()),
      (gen_random_uuid(), $2, 'agent-2', 'person-1', '{*}', null, 'theirs', 'person-1', now(), null)`,
    [KEY, OTHER_KEY, WS]
  );
  await q(
    `insert into proposals (id, api_key_id, proposal_type, status, data, created_at) values
      (gen_random_uuid(), $1, 'entity/create', 'pending', '{"summary":"Create post Hello"}', now()),
      (gen_random_uuid(), $2, 'entity/create', 'pending', '{"summary":"not mine"}', now())`,
    [KEY, OTHER_KEY]
  );
  await q(
    `insert into focus_sessions (id, title) values ($1, 'Write the launch post'), ($2, null)`,
    [S1, S2]
  );
  // S1 through two conversations: one row, its latest.
  await q(
    `insert into session_runners (session_id, client_key, api_key_id, harness, last_seen_at) values
      ($1, 'conv-a', $3, 'claude-code', now() - interval '2 hours'),
      ($1, 'conv-b', $3, 'claude-code', now() - interval '1 hour'),
      ($2, 'conv-c', $3, 'cli', now() - interval '3 hours'),
      ($2, 'conv-d', $4, 'cli', now())`,
    [S1, S2, KEY, OTHER_KEY]
  );
});

describe("readKeyDetail", () => {
  it("is null for a key that does not exist", async () => {
    expect(
      await readKeyDetail("99999999-9999-4999-8999-999999999999", "person-1")
    ).toBeNull();
  });

  it("reads only the key's LIVE grants, with space and person names", async () => {
    const d = (await readKeyDetail(KEY, "person-1"))!;
    expect(d.grants).toHaveLength(1);
    expect(d.grants[0]).toMatchObject({
      label: "Posting",
      permissions: ["entity.post.create", "entity.read"],
      workspaces: [{ id: WS, name: "Builder" }],
      projectIds: null,
      onBehalfOf: { id: "person-1", name: "Antoine" },
    });
  });

  it("folds usage per day, oldest first, counting 4xx/5xx/429 as failed; clients as read", async () => {
    const d = (await readKeyDetail(KEY, "person-1"))!;
    expect(d.usage).toEqual({
      retentionDays: 30,
      days: [
        { day: "2026-10-27", calls: 6, failed: 1 },
        { day: "2026-10-28", calls: 12, failed: 2 },
      ],
      clients: [
        { client: "claude-code", calls: 40 },
        { client: "cli", calls: 2 },
      ],
    });
    // Both reads are scoped to THIS key, through the usage door.
    expect(h.usageCalls.every((c) => c.apiKeyId === KEY)).toBe(true);
  });

  it("lists the proposals it filed and the sessions it worked in — never another key's", async () => {
    const d = (await readKeyDetail(KEY, "person-1"))!;
    expect(d.proposals.map((p) => p.summary)).toEqual(["Create post Hello"]);
    expect(d.sessions.map((s) => [s.id, s.title, s.harness])).toEqual([
      [S1, "Write the launch post", "claude-code"],
      [S2, null, "cli"],
    ]);
  });
});
