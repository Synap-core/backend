/**
 * THE POD-ACCESS FLOOR (B1, report mode), on PGlite with the real SQL:
 * `podAccessOf` (what `/api/session` returns), `reportNoPodAccess` (what every
 * guest-containment door now also calls) and `refuseGuestSession` (the
 * session side doors).
 *
 * Principals, one row each:
 *   MEMBER      — a member of a live ordinary space;
 *   POD_INVITED — a LIVE `pod_members` row and nothing else (a pod invite on a
 *                 pod with no ordinary space yet; founder Q-B1, 0357);
 *   REMOVED     — a `pod_members` row stamped `removed_at` and nothing else
 *                 (what `removeFromPod` leaves);
 *   GUEST       — a guest project role and nothing else;
 *   MIXED       — a viewer of one project AND a guest of another: the guest
 *                 containment calls them a guest, so the floor does too (the
 *                 guest answer wins; `hasActivePodAccess` alone says member);
 *   UNKNOWN     — no users row at all.
 *
 * Stubbed: the logger of `pod-access-floor` (recorded, to read the reports).
 * NOT COVERED here: that each door calls the report (the guest-containment
 * tripwires: hub routes, MCP, every tRPC procedure).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  warns: [] as Array<Record<string, unknown>>,
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
vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  return {
    ...actual,
    createLogger: (opts: { module?: string }) =>
      opts?.module === "pod-access-floor"
        ? {
            warn: (obj: Record<string, unknown>) => h.warns.push(obj),
            info: () => undefined,
            error: () => undefined,
            debug: () => undefined,
          }
        : actual.createLogger(opts as never),
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import * as schema from "@synap/database/schema";
import {
  podAccessOf,
  reportNoPodAccess,
  POD_ACCESS_FLOOR_WOULD_REFUSE,
} from "./pod-access.js";
import { refuseGuestSession } from "./guest-containment.js";

const MEMBER = randomUUID();
const POD_INVITED = randomUUID();
const REMOVED = randomUUID();
const GUEST = randomUUID();
const MIXED = randomUUID();
const UNKNOWN = randomUUID();
const W = randomUUID();
const P_VIEW = randomUUID();
const P_GUEST = randomUUID();

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
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (text: string, params?: unknown[]) => h.client!.query(text, params);

const reportsFor = (userId: string) =>
  h.warns.filter(
    (w) => w.event === POD_ACCESS_FLOOR_WOULD_REFUSE && w.userId === userId
  );

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const u of [MEMBER, POD_INVITED, REMOVED, GUEST, MIXED]) {
    await q(`insert into users (id, email) values ($1, $1 || '@x.test')`, [u]);
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'W', $2, '{}'::jsonb)`,
    [W, MEMBER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [W, MEMBER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role, removed_at) values
       (gen_random_uuid(), $1, 'member', null),
       (gen_random_uuid(), $2, 'member', now())`,
    [POD_INVITED, REMOVED]
  );
  await q(
    `insert into projects (id, name, workspace_id, status) values
       ($1, 'Viewed', $3, 'active'), ($2, 'Shared', $3, 'active')`,
    [P_VIEW, P_GUEST, W]
  );
  await q(
    `insert into project_members (project_id, user_id, role) values
       ($1, $3, 'guest'), ($2, $4, 'viewer'), ($1, $4, 'guest')`,
    [P_GUEST, P_VIEW, GUEST, MIXED]
  );
}, 120_000);

describe("podAccessOf — who the caller is to this pod", () => {
  it.each([
    ["a member of a live space", () => MEMBER, "member"],
    [
      "a live pod_members row alone (pod invite, no space)",
      () => POD_INVITED,
      "member",
    ],
    ["a removed person (stamped row, nothing else)", () => REMOVED, "none"],
    ["a guest", () => GUEST, "guest"],
    [
      "a project viewer who is a guest elsewhere: the guest answer wins",
      () => MIXED,
      "guest",
    ],
    ["an id with no users row", () => UNKNOWN, "none"],
  ])("%s → %s", async (_why, who, expected) => {
    await expect(podAccessOf(who())).resolves.toBe(expected);
  });
});

describe("reportNoPodAccess — REPORT mode: logs, never refuses", () => {
  it("reports a principal with no access, naming the door", async () => {
    h.warns.length = 0;
    await reportNoPodAccess(REMOVED, null, "hub");
    expect(reportsFor(REMOVED)).toEqual([
      expect.objectContaining({ door: "hub" }),
    ]);
  });

  it.each([
    ["a member", () => MEMBER],
    ["a pod-invited person", () => POD_INVITED],
    ["a guest (the guest containment's)", () => GUEST],
  ])("does not report %s", async (_why, who) => {
    h.warns.length = 0;
    await reportNoPodAccess(who(), null, "hub");
    expect(h.warns).toEqual([]);
  });

  it("a failed probe is logged as such and never thrown", async () => {
    h.warns.length = 0;
    await h.client!.exec(`alter table pod_members rename to pod_members_gone`);
    try {
      await expect(
        reportNoPodAccess(REMOVED, null, "hub")
      ).resolves.toBeUndefined();
    } finally {
      await h.client!.exec(
        `alter table pod_members_gone rename to pod_members`
      );
    }
    expect(h.warns.map((w) => w.event)).toEqual([
      "pod_access_floor_probe_failed",
    ]);
  });
});

describe("refuseGuestSession — the session side doors", () => {
  const app = (userId: string) =>
    new Hono()
      .use("*", async (c, next) => {
        (c.set as (k: string, v: unknown) => void)("userId", userId);
        await next();
      })
      .use("*", refuseGuestSession)
      .get("/door", (c) => c.text("served"));

  it("lets a principal with no access through (report mode) and reports it", async () => {
    h.warns.length = 0;
    const res = await app(REMOVED).request("/door");
    expect(res.status).toBe(200);
    expect(reportsFor(REMOVED)).toEqual([
      expect.objectContaining({ door: "session:/door" }),
    ]);
  });

  it("still refuses a guest, and reports nothing for one", async () => {
    h.warns.length = 0;
    const res = await app(GUEST).request("/door");
    expect(res.status).toBe(403);
    expect(h.warns).toEqual([]);
  });
});
