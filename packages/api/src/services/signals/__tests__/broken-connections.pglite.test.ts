/**
 * The BROKEN-CONNECTION half on PGlite, through the REAL read:
 *
 *  - a tool whose every live connection of the person needs a sign-in again
 *    (`secrets.connection_state = 'needs_reauth'`) is ONE ask, named after the
 *    tool, dated by its newest auth failure;
 *  - a tool with one dead account and one healthy one asks nothing (it keeps
 *    running on the healthy one); NULL is healthy (no failure ever recorded);
 *  - a `disconnected` or deleted row is no connection; another person's dead
 *    connection is not this person's ask; a plain vault secret is no tool.
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
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { capabilities, secrets } from "@synap/database/schema";
import { listBrokenConnections } from "../broken-connections.js";
import { countNeedsYou, unionNeedsYou } from "../needs-you-union.js";

const ME = "user-me";
const OTHER = "user-other";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const GMAIL = randomUUID();
const CALENDAR = randomUUID();
const SLACK = randomUUID();
const NOTION = randomUUID();
const LINEAR = randomUUID();
const OTHERS_TOOL = randomUUID();

async function tool(id: string, name: string) {
  await q(
    `insert into capabilities (id, created_by, name, approved) values ($1, 'u', $2, true)`,
    [id, name]
  );
}

async function connection(args: {
  userId: string;
  capabilityId: string | null;
  name: string;
  state: string | null;
  failedAt?: string | null;
  deleted?: boolean;
}) {
  await q(
    `insert into secrets (user_id, name, encrypted_data, iv, auth_tag, capability_id,
                          connection_state, last_auth_error_at, deleted_at)
     values ($1, $2, 'x', 'x', 'x', $3, $4, $5, $6)`,
    [
      args.userId,
      args.name,
      args.capabilityId,
      args.state,
      args.failedAt ?? null,
      args.deleted ? ago(1) : null,
    ]
  );
}

beforeAll(async () => {
  for (const t of [capabilities, secrets]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await tool(GMAIL, "Gmail");
  await tool(CALENDAR, "Google Calendar");
  await tool(SLACK, "Slack");
  await tool(NOTION, "Notion");
  await tool(LINEAR, "Linear");
  await tool(OTHERS_TOOL, "Figma");

  // Gmail: both of my accounts are dead → ONE ask, dated by the newest failure.
  await connection({
    userId: ME,
    capabilityId: GMAIL,
    name: "work",
    state: "needs_reauth",
    failedAt: ago(90),
  });
  await connection({
    userId: ME,
    capabilityId: GMAIL,
    name: "home",
    state: "needs_reauth",
    failedAt: ago(30),
  });
  // Calendar: one dead, one healthy → keeps running, no ask.
  await connection({
    userId: ME,
    capabilityId: CALENDAR,
    name: "a",
    state: "needs_reauth",
    failedAt: ago(10),
  });
  await connection({
    userId: ME,
    capabilityId: CALENDAR,
    name: "b",
    state: null,
  });
  // Slack: dead, plus one I disconnected on purpose (no connection) → an ask.
  await connection({
    userId: ME,
    capabilityId: SLACK,
    name: "s",
    state: "needs_reauth",
    failedAt: ago(120),
  });
  await connection({
    userId: ME,
    capabilityId: SLACK,
    name: "old",
    state: "disconnected",
  });
  // Notion: healthy (`connected`). Linear: its only dead row is deleted.
  await connection({
    userId: ME,
    capabilityId: NOTION,
    name: "n",
    state: "connected",
  });
  await connection({
    userId: ME,
    capabilityId: LINEAR,
    name: "l",
    state: "needs_reauth",
    failedAt: ago(5),
    deleted: true,
  });
  // Someone else's dead tool, and a plain vault entry of mine.
  await connection({
    userId: OTHER,
    capabilityId: OTHERS_TOOL,
    name: "f",
    state: "needs_reauth",
    failedAt: ago(5),
  });
  await connection({
    userId: ME,
    capabilityId: null,
    name: "bank",
    state: "needs_reauth",
  });
});

describe("broken connections — one ask per tool the person can no longer use", () => {
  it("reads only tools whose every live connection needs a sign-in, oldest break first", async () => {
    const r = await listBrokenConnections({ userId: ME });
    expect(r.truncated).toBe(false);
    expect(r.rows.map((x) => [x.capabilityId, x.name])).toEqual([
      [SLACK, "Slack"],
      [GMAIL, "Gmail"],
    ]);
    // Dated by the NEWEST auth failure among the tool's connections.
    const gmail = r.rows.find((x) => x.capabilityId === GMAIL)!;
    expect(
      Math.abs(gmail.brokenAt.getTime() - (Date.now() - 30 * 60_000))
    ).toBeLessThan(5_000);
  });

  it("another person's broken tool is not this person's ask", async () => {
    const r = await listBrokenConnections({ userId: OTHER });
    expect(r.rows.map((x) => x.capabilityId)).toEqual([OTHERS_TOOL]);
    expect((await listBrokenConnections({ userId: "nobody" })).rows).toEqual(
      []
    );
  });

  it("each read row is one needs-you row and one in the count, with its door and age", async () => {
    const { rows } = await listBrokenConnections({ userId: ME });
    const now = new Date();
    const signals = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [],
      accessRequests: {
        issuers: [],
        applications: [],
        keys: [],
        connections: rows,
      },
      now,
    });
    expect(signals.map((s) => [s.kind, s.target, s.title, s.package])).toEqual([
      [
        "access-request",
        { kind: "capability", id: GMAIL },
        'Reconnect Tool "Gmail"',
        "access",
      ],
      [
        "access-request",
        { kind: "capability", id: SLACK },
        'Reconnect Tool "Slack"',
        "access",
      ],
    ]);
    expect(signals[0]!.occurredAt.getTime()).toBe(
      rows.find((x) => x.capabilityId === GMAIL)!.brokenAt.getTime()
    );
    const counted = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      accessRequests: {
        issuers: [],
        applications: [],
        keys: [],
        connections: rows,
      },
      now,
    });
    expect(counted.requests).toBe(2);
    expect(counted.needsYou).toBe(2);
  });
});
