/**
 * `evaluateSession({ criterionKeys })` grades ONLY the criteria a fact is
 * about — the event re-check (`dev-loop/recheck-criteria.ts`) depends on it:
 * a merged PR must re-grade the criteria on that PR and never spend a check
 * on the rest of the session.
 *
 * Real: `evaluateSession` and its pending filter, over a PGlite session row.
 * Stubbed: the evaluation ledger (`record.ts` — what is RECORDED is the
 * assertion; its own retry/escalation has its own tests).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  recorded: [] as Array<{ criterionKey: string; verdict: string }>,
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
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});
vi.mock("./record.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listSessionEvaluations: async () => [],
    recordSessionEvaluation: async (p: { criterionKey: string; verdict: string }) => {
      h.recorded.push({ criterionKey: p.criterionKey, verdict: p.verdict });
      return { status: "recorded", escalated: false };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { evaluateSession } from "./evaluate.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const CRITERIA = [
  { key: "pr-backend-255", statement: "PR merged", check: { kind: "evidence", evidenceKey: "merged" } },
  { key: "ci", statement: "CI green", check: { kind: "evidence", evidenceKey: "pr-backend-255" } },
  { key: "docs", statement: "Docs written", check: { kind: "evidence", evidenceKey: "docs" } },
];
const EVIDENCE = {
  merged: { passed: true },
  "pr-backend-255": { passed: true },
  docs: { passed: true },
};

let sessionId = "";

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  sessionId = randomUUID();
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', 'active', '[]'::jsonb, $3::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [sessionId, USER, JSON.stringify(CRITERIA)]
  );
}, 120_000);
afterAll(async () => {
  await h.client?.close();
});
beforeEach(() => {
  h.recorded.length = 0;
});

describe("evaluateSession criterionKeys", () => {
  it("grades only the criteria whose key or evidence key is listed", async () => {
    const r = await evaluateSession({
      sessionId,
      userId: USER,
      evidence: EVIDENCE,
      kinds: ["evidence"],
      criterionKeys: ["pr-backend-255"],
    });
    expect(r.status).toBe("evaluated");
    expect(h.recorded.map((x) => x.criterionKey).sort()).toEqual([
      "ci",
      "pr-backend-255",
    ]);
  });

  it("without it, every pending criterion is graded (unchanged behaviour)", async () => {
    await evaluateSession({
      sessionId,
      userId: USER,
      evidence: EVIDENCE,
      kinds: ["evidence"],
    });
    expect(h.recorded.map((x) => x.criterionKey).sort()).toEqual([
      "ci",
      "docs",
      "pr-backend-255",
    ]);
  });
});
