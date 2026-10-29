/**
 * An agent's NEW session says what done means (F11, founder 29 Oct):
 * `createFocusSession({ requireCriteria: true })` refuses a start that
 * declares no criterion (NO_CRITERIA) and writes nothing; continuing a session
 * that already exists is never refused; a start without the flag (the
 * person's, every automatic start) is unchanged. Rows are read back from
 * PGlite.
 *
 * Stubbed, and why (same as `session-dedup.pglite.test.ts`): governance
 * (granted — the refusal comes before the membrane), project placement
 * (echoes the caller's), the session room and the spawn edge (own
 * connections), realtime emit.
 *
 * NOT covered here: which doors set the flag. MCP is pinned by
 * `routers/mcp/handlers/session.start-requires-criteria.test.ts`; the Hub
 * POST door's flag is read off its own line (typecheck only).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
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
        playbooks: actual.playbooks as never,
      },
    }),
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});

vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});

vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, proposals, links, playbooks } from "@synap/database";
import { createFocusSession, NO_CRITERIA } from "../create-session.js";

const USER = "user-1";
const AGENT = "agent-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def =
      c.name === "status"
        ? " default 'active'"
        : c.name === "started_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const countByGoal = (goal: string) =>
  q<{ n: number }>(
    `select count(*)::int as n from focus_sessions where goal = $1`,
    [goal]
  ).then((r) => r.rows[0]!.n);

const start = (goal: string, over: Record<string, unknown> = {}) =>
  createFocusSession({
    userId: USER,
    agentUserId: AGENT,
    projectId: PROJECT,
    goal,
    templateId: null,
    ...over,
  } as Parameters<typeof createFocusSession>[0]);

beforeAll(async () => {
  for (const t of [focusSessions, proposals, links, playbooks]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);
afterAll(async () => h.client?.close());

describe("an agent's new session declares what done means", () => {
  it("refuses a start with no criterion, and writes nothing", async () => {
    const goal = `Ship ${randomUUID()}`;
    const err = await start(goal, { requireCriteria: true }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { reasonCode?: string }).reasonCode).toBe(NO_CRITERIA);
    expect((err as Error).message).toContain("criteria: [{");
    expect(await countByGoal(goal)).toBe(0);
  });

  it("starts once a criterion is declared", async () => {
    const goal = `Ship ${randomUUID()}`;
    const res = await start(goal, {
      requireCriteria: true,
      criteria: [
        {
          key: "tests-pass",
          statement: "The new tests pass",
          check: { kind: "evidence", evidenceKey: "tests" },
        },
      ],
    });
    expect(res.status).toBe("created");
    expect(await countByGoal(goal)).toBe(1);
  });

  it("continuing a session that already exists is never refused", async () => {
    const goal = `Ship ${randomUUID()}`;
    await start(goal); // no flag: an earlier start without criteria
    const again = await start(goal, { requireCriteria: true });
    expect(again.status).toBe("deduped");
    expect(await countByGoal(goal)).toBe(1);
  });

  it("CONTROL — a start without the flag (the person's, an automatic one) is unchanged", async () => {
    const goal = `Ship ${randomUUID()}`;
    const res = await start(goal, { agentUserId: undefined });
    expect(res.status).toBe("created");
  });
});
