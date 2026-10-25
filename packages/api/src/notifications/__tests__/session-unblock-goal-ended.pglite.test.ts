/**
 * A GOAL ending is one more blocker ending (code-core F6) — on PGlite: the
 * REAL `session-unblock-notify` reactor, the REAL dependency reads
 * (`openBlockerIds`, `readDependencyState` → `deriveOpenBlockers`), the REAL
 * access predicate for the blocker goal's name. Only the notification write
 * is captured (its own suite covers the door).
 *
 * Each case names the WRONG rule it rules out.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  created: [] as Array<Record<string, unknown>>,
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

vi.mock("@synap/events", () => ({
  registerReactor: () => {},
  emitSideEffects: async () => {},
}));

vi.mock("../NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.created.push(input);
      return "n-1";
    },
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  links,
  projects,
  projectTracks,
  users,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  trackParticipants,
  notifications,
} from "@synap/database";
import { sessionUnblockNotifyReactor } from "../session-unblock-reactor.js";

const OWNER = "user-owner";
const WAITER = "user-waiter";
const STRANGER = "user-stranger";
const PROJECT = randomUUID();
const STRANGERS_PROJECT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.hasDefault && c.name === "id" ? " default gen_random_uuid()" : "";
    const now =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}${now}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function goal(
  name: string,
  status: string,
  userId = OWNER,
  projectId = PROJECT
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status, definition_snapshot, method_version, params, stage_history, metadata)
     values ($1, $2, $3, $4, $5, '{}', '1', '{}', '[]', '{}')`,
    [id, projectId, userId, name, status]
  );
  return id;
}

async function session(
  title: string,
  status: string,
  userId = WAITER
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, created_at, updated_at)
     values ($1, $2, 'ws-1', $3, $4, $5, now(), now())`,
    [id, userId, title, title, status]
  );
  return id;
}

async function edge(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  linkType = "blocked_by"
) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
    [fromType, fromId, toType, toId, linkType]
  );
}

/** The status door's emit for a move to `toStatus`. */
const moved = (goalId: string, toStatus: string) =>
  ({
    subjectType: "track",
    action: "update",
    subjectId: goalId,
    userId: OWNER,
    workspaceId: null,
    data: { trackId: goalId, fromStatus: "active", toStatus },
  }) as never;

async function fire(goalId: string) {
  const [row] = (
    await q<{ status: string }>(
      `select status from project_tracks where id = $1`,
      [goalId]
    )
  ).rows;
  await sessionUnblockNotifyReactor.handler(
    moved(goalId, row!.status),
    {} as never
  );
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    links,
    projects,
    projectTracks,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    // The waiting goal's owner seat (`goalOwnerToAsk`).
    trackParticipants,
    // `session.unblocked` is once per (dependent, blocker): the reactor reads
    // the durable row before writing.
    notifications,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, email) values ($1, 'o@x.test'), ($2, 'w@x.test'), ($3, 's@x.test')`,
    [OWNER, WAITER, STRANGER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, null, 'Launch', 'active'),
      ($3, $4, null, 'Theirs', 'active')`,
    [PROJECT, OWNER, STRANGERS_PROJECT, STRANGER]
  );
  // The waiter can SEE the goals of "Launch": by the dependency rule a
  // blocker the reader cannot see still holds them (`hidden`), so only a
  // visible closed goal can free them.
  await q(
    `insert into project_members (id, project_id, user_id, role) values (gen_random_uuid(), $1, $2, 'viewer')`,
    [PROJECT, WAITER]
  );
});

beforeEach(() => {
  h.created.length = 0;
});

describe("a goal ending — the one 'a blocker ended' rule", () => {
  it("matches only a status move that ENDS a goal", () => {
    // Rules out: reacting to every `track.update` (direction, loop, a stage).
    const m = sessionUnblockNotifyReactor.match!;
    expect(m(moved("g", "completed"))).toBe(true);
    expect(m(moved("g", "archived"))).toBe(true);
    expect(m(moved("g", "paused"))).toBe(false);
    expect(
      m({
        subjectType: "track",
        action: "update",
        subjectId: "g",
        data: { trackId: "g" },
      } as never)
    ).toBe(false);
  });

  it("a CLOSED goal that was the last blocker unblocks the session — session.unblocked", async () => {
    const blocker = await goal("Price the plans", "completed");
    const waiting = await session("Write the launch post", "active");
    await edge("session", waiting, "track", blocker);

    await fire(blocker);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      type: "session.unblocked",
      userId: WAITER,
      sourceId: waiting,
      data: {
        sessionId: waiting,
        blockerGoalId: blocker,
        blockerTitle: "Price the plans",
      },
    });
  });

  it("a DROPPED goal holds the dependent — it is told to re-plan, never 'free'", async () => {
    // Rules out: announcing any ending as an unblocking.
    const blocker = await goal("Old pricing", "archived");
    const waiting = await session("Draft the FAQ", "active");
    await edge("session", waiting, "track", blocker);

    await fire(blocker);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      type: "session.blocker_goal_ended",
      data: { delivered: false, endedWord: "dropped" },
    });
    expect(String((h.created[0]!.data as { outcome: string }).outcome)).toMatch(
      /re-plan/
    );
  });

  it("stays SILENT while another blocker still holds the dependent; tells it when the last one closes", async () => {
    // Rules out: the second rule F6 removed — "it still waits on 1 other
    // thing", told on every blocker that ends.
    const blocker = await goal("Brand kit", "completed");
    const other = await goal("Legal review", "active");
    const waiting = await goal("Public launch", "active", WAITER);
    await edge("track", waiting, "track", blocker);
    await edge("track", waiting, "track", other);

    await fire(blocker);
    expect(h.created).toHaveLength(0);

    await q(`update project_tracks set status = 'completed' where id = $1`, [
      other,
    ]);
    await fire(other);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      type: "track.blocker_ended",
      // The waiting GOAL's owner (`goalOwnerToAsk` = project_tracks.user_id).
      userId: WAITER,
      sourceType: "track",
      sourceId: waiting,
      data: { delivered: true, outcome: "nothing else holds it up." },
    });
  });

  it("stays silent while the goal is still live", async () => {
    // Rules out: trusting the event instead of the row.
    const blocker = await goal("Still going", "active");
    const waiting = await session("Waits", "active");
    await edge("session", waiting, "track", blocker);

    await fire(blocker);

    expect(h.created).toHaveLength(0);
  });

  it("tells nobody about a dependent that already ended", async () => {
    const blocker = await goal("Done thing", "completed");
    const finished = await session("Already closed", "closed");
    await edge("session", finished, "track", blocker);

    await fire(blocker);

    expect(h.created).toHaveLength(0);
  });

  it("reaches dependents of a goal this one REPLACED", async () => {
    // Rules out: missing the people waiting on the old version of a reopened goal.
    const old = await goal("Pricing v1", "completed");
    const current = await goal("Pricing v2", "completed");
    await edge("track", current, "track", old, "replaces");
    const waiting = await session("Waits on v1", "active");
    await edge("session", waiting, "track", old);

    await fire(current);

    expect(h.created.map((c) => c.sourceId)).toContain(waiting);
  });

  it("a goal the recipient cannot see: closed, it still holds them (silent); dropped, they are told without its name", async () => {
    // Rules out: leaking a private goal's name through a dependency — and
    // telling someone they are free while the one dependency rule (`hidden`
    // still holds) keeps them blocked.
    const closedHidden = await goal(
      "Secret merger",
      "completed",
      STRANGER,
      STRANGERS_PROJECT
    );
    const waitsOnClosed = await session("Plan around the merger", "active");
    await edge("session", waitsOnClosed, "track", closedHidden);
    await fire(closedHidden);
    expect(h.created).toHaveLength(0);

    const hidden = await goal(
      "Secret acquisition",
      "archived",
      STRANGER,
      STRANGERS_PROJECT
    );
    const waiting = await session("Plan around it", "active");
    await edge("session", waiting, "track", hidden);

    await fire(hidden);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      data: { blockerTitle: "A goal it was waiting on" },
    });
  });
});
