/**
 * tRPC `playbookRuns.cancelRun` — the SAME `cancelRun` as Hub
 * `POST /runs/:runId/cancel` (one function, two transports): an agent key is
 * refused, a run that is not the caller's session reads as missing, and the
 * owner's cancel reaches the shared function and maps its outcomes.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  calls: [] as Array<Record<string, unknown>>,
  next: null as null | Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      playbookRuns: actual.playbookRuns as never,
    },
  });
  return { ...actual, db, getDb: async () => db };
});
// The mutation guard's split-brain read is its own suite.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
}));
vi.mock("../services/agent-dispatch/cancel-run.js", () => ({
  cancelRun: async (p: Record<string, unknown>) => {
    h.calls.push(p);
    return h.next ?? { status: "cancelled", externalCancelled: true };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, playbookRuns } from "@synap/database";
import { playbookRunsRouter } from "./playbook-runs.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = "owner-1";
const caller = (ctx: Record<string, unknown>) =>
  playbookRunsRouter.createCaller({ authenticated: true, ...ctx } as never);

async function run(): Promise<string> {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, criteria) values ($1, $2, 'g', 'active', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
    [sessionId, OWNER]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by) values ($1, $2, $3, 'external-agent', 'running', '{}'::jsonb, $4)`,
    [runId, randomUUID(), sessionId, OWNER]
  );
  return runId;
}

describe("playbookRuns.cancelRun", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, playbookRuns]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  }, 120_000);
  beforeEach(() => {
    h.calls.length = 0;
    h.next = null;
  });

  it("an agent key is refused before anything is read", async () => {
    const runId = await run();
    await expect(
      caller({ userId: OWNER, agentUserId: "agent-1" }).cancelRun({ runId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.calls).toHaveLength(0);
  });

  it("another person's run reads as NOT_FOUND", async () => {
    const runId = await run();
    await expect(
      caller({ userId: "someone-else" }).cancelRun({ runId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.calls).toHaveLength(0);
  });

  it("the owner's cancel reaches the ONE cancelRun and maps its outcomes", async () => {
    const runId = await run();
    expect(await caller({ userId: OWNER }).cancelRun({ runId })).toEqual({
      runId,
      status: "cancelled",
      externalCancelled: true,
      note: null,
    });
    expect(h.calls).toEqual([{ runId, userId: OWNER }]);
    h.next = { status: "cancel_failed", message: "provider down" };
    await expect(
      caller({ userId: OWNER }).cancelRun({ runId })
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    h.next = { status: "not_live", runStatus: "completed" };
    await expect(
      caller({ userId: OWNER }).cancelRun({ runId })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
