/**
 * GET /work-release for a key pinned to a space (a pod app: DevPlane's Ship
 * page, finding 4d14ce47): the release read narrowed to what its grant
 * reaches, every part it does not reach said `withheld`.
 *
 * The door used to be an aggregate read (`READS` of event, session, channel,
 * proposal), which no pinned grant passes: every app was refused
 * GRANT_DOOR_UNSUPPORTED. The fence now admits a key that reads some `event`
 * family (grant-door-fence.test.ts: a key with no event read is still
 * refused); the READ narrows itself (`workReleaseReach`).
 *
 * Through the REAL route and the REAL `readWorkRelease` on PGlite, the grant
 * set as the auth middleware sets it (`runWithGrant`). Rows sit where the
 * candidate rules DISAGREE:
 *   - a snapshot stamped in Builder, one stamped in another space and one
 *     posted pod-wide: a read without the space clause shows all three;
 *   - a session in Builder and one in another space, both named by a PR of
 *     the Builder snapshot: a session read without the grant clause titles
 *     both;
 *   - activity in the Builder session 2 min ago: a read that measured liveness
 *     would mark it live; a narrowed read withholds it;
 *   - a key whose event read is the CI family only: "missing" (a calm empty
 *     board) vs "withheld".
 * Cannot see: the fence wiring in the auth middleware (its own tests), a real
 * Postgres, and a producer that stamps no space (that is the rule, below).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import "../../../access/grant-read.js";
import type { WorkReleaseRead } from "@synap-core/types/work-release";
import type { HubHono, HubVariables } from "./_shared.js";

const { registerWorkReleaseRoutes } = await import("./work-release.js");

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

const OWNER = randomUUID();
const AGENT = randomUUID();
const BUILDER = randomUUID(); // the space the app was granted
const ELSEWHERE = randomUUID(); // the person's other space
const BE = "Synap-core/backend"; // stamped in Builder
const BR = "Synap-core/browser"; // posted pod-wide
const CRM = "Synap-core/crm"; // stamped in the other space
const S_IN = randomUUID(); // a Builder session, named by backend#363
const S_OUT = randomUUID(); // another space's session, named by backend#278
const NOW = new Date();
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const SHA = (n: number) => n.toString(16).padStart(40, "a");

function pr(repo: string, number: number, podSessionId?: string) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headSha: SHA(number),
    draft: false,
    author: "Antoinesrvt",
    updatedAt: ago(20).toISOString(),
    mergeable: "clean",
    checks: "green",
    autoMerge: false,
    ...(podSessionId ? { podSessionId } : {}),
  };
}

async function snapshot(
  repo: string,
  workspaceId: string | null,
  prs: unknown[]
) {
  const data = {
    repo,
    observedAt: ago(1).toISOString(),
    visibility: "private",
    main: { sha: SHA(1), health: "ok", source: "github-checks" },
    prs,
    mergedToday: [],
  };
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, workspace_id, data, timestamp)
     values ($1, 'dev.repo_snapshot', $2, $3, 'repo_snapshot', $4, $5::jsonb, $6)`,
    [randomUUID(), OWNER, repo, workspaceId, JSON.stringify(data), ago(1)]
  );
}

async function session(id: string, workspaceId: string, title: string) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, title, goal, status, expected_outputs, agent_ids, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'g', 'active', '[]'::jsonb, $5::text[], '{}'::jsonb, now() - interval '3 hours', now(), now())`,
    [id, OWNER, workspaceId, title, `{${AGENT}}`]
  );
}

const pinned = (...permissions: string[]) => ({
  scopes: [{ permissions, workspaceIds: [BUILDER] }],
  clientId: "app_devplane",
});

async function get(grant?: unknown): Promise<{ status: number; text: string }> {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerWorkReleaseRoutes(app);
  const send = () => app.request("/work-release");
  const res = await (grant ? runWithGrant(grant as never, send) : send());
  return { status: res.status, text: await res.text() };
}

const prOf = (r: WorkReleaseRead, n: number) =>
  r.prs.find((p) => p.number === n);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  // Non-vacuity: the schema walk saw the tables this read joins.
  expect(tables.map((t) => getTableConfig(t).name)).toEqual(
    expect.arrayContaining(["events", "focus_sessions", "users", "workspaces"])
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@test', 'Antoine', 'human'), ($2, 'a@test', 'Claude Code', 'agent')`,
    [OWNER, AGENT]
  );
  for (const [id, name] of [
    [BUILDER, "Builder"],
    [ELSEWHERE, "Elsewhere"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [id, name, OWNER]
    );
  }
  await session(S_IN, BUILDER, "Ship the door");
  await session(S_OUT, ELSEWHERE, "Secret elsewhere");
  // Activity inside the Builder session 2 min ago: live, if it were measured.
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, session_id, workspace_id, data, timestamp)
     values ($1, 'entity.create.completed', $2, $3, 'entity', $4, $5, '{}'::jsonb, $6)`,
    [randomUUID(), OWNER, randomUUID(), S_IN, BUILDER, ago(2)]
  );

  await snapshot(BE, BUILDER, [pr(BE, 363, S_IN), pr(BE, 278, S_OUT)]);
  await snapshot(BR, null, [pr(BR, 60)]);
  await snapshot(CRM, ELSEWHERE, [pr(CRM, 7)]);
});

describe("GET /work-release — an app pinned to Builder reads Ship, narrowed", () => {
  it("reads the snapshots stamped in Builder only, the sessions its grant reaches, holders withheld", async () => {
    const res = await get(pinned("event.dev.read", "session.read"));
    expect(res.status).toBe(200);
    const r = JSON.parse(res.text) as WorkReleaseRead;
    // Neither the pod-wide snapshot nor the other space's.
    expect(r.repos.map((x) => x.repo)).toEqual([BE]);
    expect(r.sources).toEqual({
      snapshots: "ok",
      sessions: "ok",
      holders: "withheld",
    });
    expect(prOf(r, 363)).toMatchObject({
      sessionId: S_IN,
      sessionTitle: "Ship the door",
      holder: null,
    });
    // The other space's session: named by the snapshot, never read.
    expect(prOf(r, 278)).toMatchObject({ sessionTitle: null, holder: null });
    expect(res.text).not.toContain("Secret elsewhere");
    expect(res.text).not.toContain(BR);
    expect(res.text).not.toContain(CRM);
    expect(r.narrowed).toMatchObject({
      snapshotSpaces: [BUILDER],
      withheld: ["holders"],
    });
  });

  it("a key that reads no session gets the sessions withheld, not 'none'", async () => {
    const res = await get(pinned("event.dev.read"));
    expect(res.status).toBe(200);
    const r = JSON.parse(res.text) as WorkReleaseRead;
    expect(r.sources.sessions).toBe("withheld");
    expect(prOf(r, 363)?.sessionTitle).toBeNull();
    expect(res.text).not.toContain("Ship the door");
  });

  it("a key whose event read is not the dev family: snapshots withheld, never 'missing'", async () => {
    const res = await get(pinned("event.ci.read", "session.read"));
    expect(res.status).toBe(200);
    const r = JSON.parse(res.text) as WorkReleaseRead;
    expect(r.sources.snapshots).toBe("withheld");
    expect(r.repos).toEqual([]);
    expect(r.narrowed?.withheld).toEqual(["snapshots", "holders"]);
  });

  it("CONTROL: the person (no key grant) reads every snapshot, both sessions and who is working", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const r = JSON.parse(res.text) as WorkReleaseRead;
    expect(r.repos.map((x) => x.repo)).toEqual([BE, BR, CRM]);
    expect(r.sources).toEqual({
      snapshots: "ok",
      sessions: "ok",
      holders: "ok",
    });
    expect(prOf(r, 278)?.sessionTitle).toBe("Secret elsewhere");
    expect(prOf(r, 363)?.holder).toMatchObject({
      live: true,
      label: "Claude Code",
    });
    expect(r.narrowed).toBeUndefined();
  });
});
