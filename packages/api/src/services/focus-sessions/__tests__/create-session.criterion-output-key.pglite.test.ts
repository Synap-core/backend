/**
 * W1 (work model, plan 8daa514b): a criterion may name the session output it
 * checks (`outputKey`). Additive only — this pins that the field SURVIVES the
 * real write door and the real reader:
 *
 *   createFocusSession (`sessionCriteriaSchema`, strict) → the `criteria`
 *   jsonb row in PGlite → `readCriteria` (which rebuilds each criterion field
 *   by field, and so drops any field it has not learned).
 *
 * Either half losing it fails here: the strict schema refusing the field
 * throws on the start, the reader not knowing it reads the criterion back
 * without it.
 *
 * Stubbed, and why (same harness as `create-session.require-criteria`):
 * governance (granted), project placement (echoes the caller's), the session
 * room and the spawn edge (own connections), realtime emit.
 *
 * NOT covered here: any reader pairing a criterion with its output by this key
 * (that is W4), and the MCP / Hub doors (they hand the list to this door).
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
import { readCriteria } from "@synap/playbooks";
import { createFocusSession } from "../create-session.js";

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

const storedCriteria = (goal: string) =>
  h
    .client!.query<{ criteria: unknown }>(
      `select criteria from focus_sessions where goal = $1`,
      [goal]
    )
    .then((r) => r.rows[0]?.criteria);

beforeAll(async () => {
  for (const t of [focusSessions, proposals, links, playbooks]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);
afterAll(async () => h.client?.close());

describe("a criterion's outputKey survives the write door and the reader (W1)", () => {
  it("written by createFocusSession, read back by readCriteria", async () => {
    const goal = `Ship ${randomUUID()}`;
    const withOutput = {
      key: "pr-green",
      statement: "The PR's required checks are green",
      check: { kind: "evidence", evidenceKey: "checks" },
      outputKey: "pr-backend",
    };
    const without = {
      key: "tests-pass",
      statement: "The new tests pass",
      check: { kind: "evidence", evidenceKey: "tests" },
    };
    const res = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      projectId: PROJECT,
      goal,
      templateId: null,
      criteria: [withOutput, without],
    } as Parameters<typeof createFocusSession>[0]);
    expect(res.status).toBe("created");

    // Non-vacuous: the row exists and holds both criteria.
    const raw = await storedCriteria(goal);
    const read = readCriteria(typeof raw === "string" ? JSON.parse(raw) : raw);
    expect(read.map((c) => c.key)).toEqual(["pr-green", "tests-pass"]);

    expect(read[0]).toEqual(withOutput);
    // CONTROL — a criterion that names no output reads back with none.
    expect(read[1]).toEqual(without);
    expect("outputKey" in read[1]!).toBe(false);
  });

  it("a malformed outputKey is refused in words, and nothing is written", async () => {
    const goal = `Ship ${randomUUID()}`;
    const err = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      projectId: PROJECT,
      goal,
      templateId: null,
      criteria: [
        {
          key: "pr-green",
          statement: "The PR's required checks are green",
          check: { kind: "human" },
          outputKey: "The PR",
        },
      ],
    } as Parameters<typeof createFocusSession>[0]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("outputKey");
    expect(await storedCriteria(goal)).toBeUndefined();
  });
});
