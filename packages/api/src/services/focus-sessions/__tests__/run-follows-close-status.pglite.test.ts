/**
 * A session's playbook run takes its terminal status FROM HOW THE SESSION
 * CLOSED. `complete-session.ts` used to stamp `completed` for `failed` and
 * `cancelled` closes too, so a failed child never failed its parent automation
 * run (the settle helper only reacts to a `failed` child). Drives the REAL
 * `completeFocusSession` on PGlite and asserts the run row + the settle call.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  emitted: [] as Array<Record<string, unknown>>,
  pushes: [] as Array<Record<string, unknown>>,
  sockets: [] as Array<Record<string, unknown>>,
  settled: [] as Array<{ playbookRunId: string }>,
}));

vi.mock("@synap/jobs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    settleParentAutomationRunFromChild: async (input: {
      playbookRunId: string;
    }) => {
      h.settled.push(input);
      return (
        actual.settleParentAutomationRunFromChild as (i: unknown) => unknown
      )(input);
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
      schema: {
        focusSessions: actual.focusSessions as never,
        sessionEvaluations: actual.sessionEvaluations as never,
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (e: Record<string, unknown>) => {
      h.emitted.push(e);
    },
  };
});

vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async (input: Record<string, unknown>) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));

vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (e: Record<string, unknown>) => {
    h.sockets.push(e);
  },
}));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  playbookRuns,
  proposals,
  notifications,
  notificationPreferences,
  users,
} from "@synap/database";
import {
  completeFocusSession,
  SESSION_FAILED_RUN_ERROR,
} from "../complete-session.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [
    focusSessions,
    playbooks,
    playbookRuns,
    proposals,
    notifications,
    notificationPreferences,
    users,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into users (id, email, timezone) values ($1, $2, 'UTC')`,
    [USER, "user-1@example.test"]
  );
  await h.client!.exec(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../database/migrations/0267_session_criteria_and_evaluations.sql"
      ),
      "utf8"
    )
  );
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

const CASES = [
  { close: "closed", run: "completed", error: null },
  { close: "failed", run: "failed", error: SESSION_FAILED_RUN_ERROR },
  { close: "cancelled", run: "cancelled", error: null },
] as const;

describe("a session's run follows the session's close status", () => {
  it.each(CASES)(
    "session closes as $close => run is $run and the parent settle is asked",
    async ({ close, run: expected, error }) => {
      const sessionId = randomUUID();
      const runId = randomUUID();
      await q(
        `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
         values ($1, $2, 'Ship', 'Ship', 'active', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
        [sessionId, USER]
      );
      await q(
        `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, started_at)
         values ($1, $2, $3, 'external-agent', 'running', '{}'::jsonb, $4, now())`,
        [runId, randomUUID(), sessionId, USER]
      );
      h.settled.length = 0;

      await completeFocusSession({
        sessionId,
        userId: USER,
        terminalStatus: close,
      });

      const [row] = (
        await q<{
          status: string;
          error: string | null;
          completed_at: string | null;
        }>(
          `select status, error, completed_at from playbook_runs where id = $1`,
          [runId]
        )
      ).rows;
      expect(row!.status).toBe(expected);
      expect(row!.error).toBe(error);
      expect(row!.completed_at).not.toBeNull();
      expect(h.settled).toEqual([{ playbookRunId: runId }]);
    }
  );
});
