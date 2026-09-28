/**
 * W2 review P1 — a run the reaper parked as `waiting_on_you` must still
 * FINISH through the real close door once its session is done. Every live-run
 * lookup used to match `status = 'running'` only, so the parked run stayed
 * waiting forever. Drives the REAL `completeFocusSession` on PGlite.
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
import { completeFocusSession } from "../complete-session.js";

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

const OWED = {
  label: "Stripe key",
  kind: "credential",
  owner: "human",
  owedSince: "2026-09-01T00:00:00.000Z",
};

describe("a parked (waiting_on_you) run finishes with its session", () => {
  it("park → answer the slot → complete the session ⇒ the run is `completed`", async () => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
       values ($1, $2, 'Ship', 'Ship', 'active', $3::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
      [sessionId, USER, JSON.stringify([OWED])]
    );
    // Parked by the reaper: the session owed the person.
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, started_at)
       values ($1, $2, $3, 'external-agent', 'waiting_on_you', '{}'::jsonb, $4, now() - interval '30 hours')`,
      [runId, randomUUID(), sessionId, USER]
    );
    // The person answers.
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [sessionId, JSON.stringify([{ ...OWED, status: "done" }])]
    );

    await completeFocusSession({ sessionId, userId: USER });

    const [run] = (
      await q<{ status: string; completed_at: string | null }>(
        `select status, completed_at from playbook_runs where id = $1`,
        [runId]
      )
    ).rows;
    expect(run!.status).toBe("completed");
    expect(run!.completed_at).not.toBeNull();
  });
});
