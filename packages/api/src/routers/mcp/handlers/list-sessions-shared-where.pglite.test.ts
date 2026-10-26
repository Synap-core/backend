/**
 * `synap_list_sessions` reads the ONE session WHERE (`sessionListConditions`)
 * — the REAL handler on PGlite, every table generated from the Drizzle
 * definitions.
 *
 * Two kinds of rows, and each is there to rule a rule OUT:
 *   - PRESERVED behaviour, where the shared WHERE's own defaults would differ
 *     from this door's: an agent DRAFT (the default `lens` hides it) and a
 *     playbook RUN (the default `kind: "work"` hides it) must still list; the
 *     default status is still `open` (a closed and a stale session stay out);
 *     another person's session never lists.
 *   - The two deliberate changes: the key's GRANT now bounds the read (the
 *     shared floor, `sessionReadableWhere`), and `subjectEntityId` reads the
 *     subject predicate the Hub door reads (a worker session targeting the
 *     thing lists beside the one whose subject it is). Both read RED on the
 *     hand-written WHERE this door used to carry.
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
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, { schema });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant, type KeyGrant } from "@synap/database";
import type { McpToolContext } from "./shared.js";

const { sessionHandlers } = await import("./session.js");

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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-list";
const OTHER = "user-other";
const W1 = randomUUID();
const W2 = randomUUID();
const THING = randomUUID();

const S = {
  work: randomUUID(), // active work in W1
  draft: randomUUID(), // agent-opened, not accepted, in W1
  run: randomUUID(), // a playbook run, in W1
  closed: randomUUID(), // closed, in W1
  stale: randomUUID(), // stale, in W1
  inW2: randomUUID(), // active work in W2
  others: randomUUID(), // OTHER's active work in W1
  onThing: randomUUID(), // subject = THING
  worker: randomUUID(), // a worker session targeting THING
};

async function session(
  id: string,
  opts: {
    user?: string;
    status?: string;
    workspaceId?: string | null;
    origin?: string | null;
    playbookId?: string | null;
    subjectEntityId?: string | null;
  } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, goal, status, workspace_id, origin, playbook_id, subject_entity_id, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at)
     values ($1, $2, 'g', $3, $4, $5, $6, $7, '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [
      id,
      opts.user ?? USER,
      opts.status ?? "active",
      opts.workspaceId === undefined ? W1 : opts.workspaceId,
      opts.origin ?? null,
      opts.playbookId ?? null,
      opts.subjectEntityId ?? null,
    ]
  );
}

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_list_sessions",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read"],
  } as unknown as McpToolContext;
}

async function list(args: Record<string, unknown>): Promise<string[]> {
  const res = (await sessionHandlers.synap_list_sessions!(ctx(args))) as {
    content: Array<{ text?: string }>;
  };
  const body = JSON.parse(res.content[0]!.text!) as {
    sessions?: Array<{ id: string }>;
    error?: string;
  };
  if (body.error) throw new Error(body.error);
  return body.sessions!.map((s) => s.id);
}

beforeAll(async () => {
  const tables = Object.values(schema).filter((v): v is PgTable =>
    is(v, PgTable)
  );
  expect(tables.map((t) => getTableConfig(t).name)).toEqual(
    expect.arrayContaining(["focus_sessions", "links"])
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await session(S.work);
  await session(S.draft, { origin: "agent" });
  await session(S.run, { playbookId: randomUUID() });
  await session(S.closed, { status: "closed" });
  await session(S.stale, { status: "stale" });
  await session(S.inW2, { workspaceId: W2 });
  await session(S.others, { user: OTHER });
  await session(S.onThing, { subjectEntityId: THING });
  await session(S.worker, { origin: "automation" });
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'entity', $3, 'targets', '{"role":"worker_target"}'::jsonb, now())`,
    [randomUUID(), S.worker, THING]
  );
}, 60_000);

describe("synap_list_sessions — the door's own defaults survive the shared WHERE", () => {
  it("defaults to open sessions of every kind and every lens, the owner's only", async () => {
    const ids = await list({});
    expect(ids).toEqual(
      expect.arrayContaining([S.work, S.draft, S.run, S.inW2])
    );
    expect(ids).not.toContain(S.closed);
    expect(ids).not.toContain(S.stale);
    expect(ids).not.toContain(S.others);
  });

  it("one exact status, `all`, a kind and a workspace still narrow as before", async () => {
    expect(await list({ status: "stale" })).toEqual([S.stale]);
    expect(await list({ status: "all" })).toEqual(
      expect.arrayContaining([S.closed, S.stale, S.work])
    );
    const runs = await list({ kind: "run" });
    expect(runs).toContain(S.run);
    expect(runs).not.toContain(S.work);
    expect(await list({ workspaceId: W2 })).toEqual([S.inW2]);
  });

  it("answers an off-vocabulary value with the vocabulary", async () => {
    await expect(list({ status: "done" })).rejects.toThrow(/Valid values/);
    await expect(list({ kind: "task" })).rejects.toThrow(/Valid values/);
    await expect(list({ subjectEntityId: "nope" })).rejects.toThrow(
      /not a valid id/
    );
  });
});

describe("synap_list_sessions — the shared floor and the shared subject predicate", () => {
  it("is bounded by the calling key's grant", async () => {
    const pinned: KeyGrant = {
      scopes: [{ permissions: ["session.read"], workspaceIds: [W1] }],
      clientId: null,
    };
    const ids = await runWithGrant(pinned, () => list({}));
    expect(ids).toContain(S.work);
    expect(ids).not.toContain(S.inW2);
  });

  it("lists a worker session targeting the thing beside the one about it", async () => {
    const ids = await list({ subjectEntityId: THING });
    expect(ids.sort()).toEqual([S.onThing, S.worker].sort());
  });
});
