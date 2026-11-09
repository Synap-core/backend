/**
 * `listAgentRuns({ sessionId })` — "what did this session's agents run?", as
 * REAL SQL on PGlite. The session id rides in `data->>'sessionId'` (written by
 * POST /api/hub/agent-runs, not the `session_id` column), and the owner clamp
 * must still hold when the filter is set.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EventRepository } from "../event-repository.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

let repo: EventRepository;

beforeAll(async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE events (
    id text PRIMARY KEY,
    type text NOT NULL,
    subject_type text,
    subject_id text,
    user_id text,
    data jsonb,
    metadata jsonb,
    source text,
    correlation_id text,
    is_agent boolean,
    agent_user_id text,
    agent_type text,
    model text,
    provider text,
    cost_usd numeric,
    tokens_in int,
    tokens_out int,
    tokens_total int,
    latency_ms int,
    tool_count int,
    run_status text,
    finish_reason text,
    workspace_id text,
    timestamp timestamptz NOT NULL DEFAULT now()
  );`);
  const rows: Array<[string, string, string | null]> = [
    ["r1", "user-1", SESSION],
    ["r2", "user-1", OTHER_SESSION],
    ["r3", "user-1", null],
    ["r4", "user-2", SESSION], // another owner, same session: never returned
  ];
  for (const [id, userId, sessionId] of rows) {
    await pg.query(
      `INSERT INTO events (id, type, user_id, data)
       VALUES ($1, 'agentRun.create.completed', $2, $3::jsonb)`,
      [id, userId, JSON.stringify(sessionId ? { sessionId } : {})]
    );
  }
  repo = new EventRepository({
    unsafe: async (sql: string, params: unknown[]) =>
      (await pg.query(sql, params)).rows,
  } as never);
});

describe("listAgentRuns sessionId filter", () => {
  it("returns only that session's runs, clamped to the owner", async () => {
    const runs = await repo.listAgentRuns({
      userId: "user-1",
      sessionId: SESSION,
    });
    expect(runs.map((r) => r.id)).toEqual(["r1"]);
  });

  it("without sessionId every run of the owner comes back", async () => {
    const runs = await repo.listAgentRuns({ userId: "user-1" });
    expect(runs.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  });
});
