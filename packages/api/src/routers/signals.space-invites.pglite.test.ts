/**
 * Open invites to another space of this pod in the needs-you union (wave PQ
 * 2026-10-22), against real SQL (PGlite, every table) through the REAL
 * signals read — the `invites` rows `workspaces.listMyInvites` would return,
 * read by `listOpenSpaceInvites`, unioned and counted by `signals.list` /
 * `signals.count`:
 *
 *  - an open invite addressed to the viewer's email is ONE `space-invite`
 *    row at the floor, carrying the token Accept takes, and `invites` is a
 *    part of THE number (`needsYou` counts it);
 *  - an expired invite, and one addressed to someone else, are no row;
 *  - under a space lens there is none (an invite lives in no space the
 *    person is in yet);
 *  - a viewer with no email is addressed by no invite: empty, not a failure.
 *
 * Stubbed: the review and access-request halves (their own suites), so the
 * numbers here are the invites' and nothing else's.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("../services/projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async () => ({ sessions: [], truncated: false }),
}));
vi.mock("../services/signals/access-requests.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listPendingIssuers: async () => ({ rows: [], truncated: false }),
  listPendingAppRequests: async () => ({ rows: [], truncated: false }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { signalsRouter } from "./signals.js";
import { listOpenSpaceInvites } from "../services/signals/space-invites.js";

const ME = "user-me";
const NO_EMAIL = "user-no-email";
const MINE = randomUUID();
const RESEARCH = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def = ["created_at", "updated_at", "timestamp", "started_at"].includes(
      c.name
    )
      ? " default now()"
      : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ctxOf = (userId: string) =>
  ({ db: null, authenticated: true, userId, workspaceId: null }) as never;

async function invite(o: {
  email: string;
  workspaceId: string | null;
  type?: "workspace" | "pod";
  token: string;
  expiresInHours: number;
}) {
  await q(
    `insert into invites (id, type, workspace_id, email, role, token, invited_by, expires_at, created_at)
     values (gen_random_uuid(),$1,$2,$3,'editor',$4,'owner-1', now() + ($5 || ' hours')::interval, now())`,
    [o.type ?? "workspace", o.workspaceId, o.email, o.token, String(o.expiresInHours)]
  );
}

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human'), ($2,'Nobody',null,'human')`,
    [ME, NO_EMAIL]
  );
  for (const [id, name] of [
    [MINE, "Mine"],
    [RESEARCH, "Research"],
  ] as const)
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,'owner-1','{}'::jsonb)`,
      [id, name]
    );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(),$1,$2,'owner')`,
    [MINE, ME]
  );
  // Open, addressed to me — the one row.
  await invite({ email: "me@x.io", workspaceId: RESEARCH, token: "tok-open", expiresInHours: 168 });
  // Expired — no row.
  await invite({ email: "me@x.io", workspaceId: RESEARCH, token: "tok-gone", expiresInHours: -1 });
  // Someone else's — no row.
  await invite({ email: "else@x.io", workspaceId: RESEARCH, token: "tok-else", expiresInHours: 168 });
});

describe("open space invites in needs-you (real read)", () => {
  it("the open invite is ONE space-invite row at the floor, with the token Accept takes", async () => {
    const { signals } = (await signalsRouter
      .createCaller(ctxOf(ME))
      .list({ lens: "needs-you" })) as { signals: Array<Record<string, unknown>> };
    const invites = signals.filter((s) => s.kind === "space-invite");
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      title: "Research",
      target: null,
      invite: { token: "tok-open", role: "editor", scope: "workspace", spaceName: "Research" },
    });
  });

  it("`invites` is a part of THE number at the floor, and the number counts it", async () => {
    const count = await signalsRouter.createCaller(ctxOf(ME)).count({});
    expect(count.invites).toBe(1);
    expect(count.needsYou).toBe(
      count.decisions + count.notifications + count.blocked + count.review + count.captures + count.requests + count.invites
    );
    expect(count.needsYou).toBeGreaterThanOrEqual(1);
  });

  it("under a space lens there is no invite row and no invite count", async () => {
    const caller = signalsRouter.createCaller(ctxOf(ME));
    expect((await caller.count({ workspaceId: MINE })).invites).toBe(0);
    const { signals } = (await caller.list({ lens: "needs-you", workspaceId: MINE })) as {
      signals: Array<{ kind: string }>;
    };
    expect(signals.some((s) => s.kind === "space-invite")).toBe(false);
  });

  it("a viewer with no email is addressed by no invite — empty, never a failure", async () => {
    expect(await listOpenSpaceInvites({ userId: NO_EMAIL })).toEqual({ rows: [], truncated: false });
    expect((await signalsRouter.createCaller(ctxOf(NO_EMAIL)).count({})).invites).toBe(0);
  });
});
