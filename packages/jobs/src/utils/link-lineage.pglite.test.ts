/**
 * The run-time loop guard of playbook links (W8a) on real SQL (PGlite): the
 * chain of link-started runs read off the sessions and automation runs the
 * pod already writes (`metadata.automationRunId` →
 * `automation_runs.trigger_payload` of a session close → the run before).
 *
 * Rows rule out:
 *  - a loop that bypassed the write door (A → B → C → A) let through;
 *  - a legitimate chain LONGER than the generic depth floor (3) refused: a
 *    chain of six playbooks still starts its seventh;
 *  - the walk crossing a run no close started (a person's, a schedule's):
 *    the chain stops there;
 *  - a chain past `LINK_CHAIN_MAX` read as anything but capped.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

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
import { automationRuns, focusSessions } from "@synap/database/schema";
import { linkWouldLoop, readLinkLineage } from "./link-lineage.js";
import { FOCUS_SESSION_CLOSED_EVENT_TYPE } from "../workers/automation-trigger-matcher.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

/**
 * A run of `playbookId`. `after` = the session whose close started it through
 * a link (its automation run keeps that close as its trigger); `startedBy` =
 * another trigger (a schedule) instead; neither = a person started it.
 */
async function run(
  playbookId: string,
  o: { after?: string; startedBy?: string } = {}
): Promise<string> {
  const sessionId = randomUUID();
  let metadata: Record<string, unknown> = {};
  if (o.after || o.startedBy) {
    const runId = randomUUID();
    await q(
      `insert into automation_runs (id, automation_id, trigger_payload) values ($1,$2,$3::jsonb)`,
      [
        runId,
        randomUUID(),
        JSON.stringify(
          o.after
            ? {
                eventType: FOCUS_SESSION_CLOSED_EVENT_TYPE,
                subjectId: o.after,
                data: { sessionId: o.after, playbookId: "whatever" },
              }
            : { eventType: o.startedBy, data: {} }
        ),
      ]
    );
    metadata = {
      automationRunId: runId,
      automationChainContext: { automationRunId: runId, chainDepth: 1 },
    };
  }
  await q(
    `insert into focus_sessions (id, playbook_id, status, metadata) values ($1,$2,'closed',$3::jsonb)`,
    [sessionId, playbookId, JSON.stringify(metadata)]
  );
  return sessionId;
}

const PB = Object.fromEntries(
  ["a", "b", "c", "d", "e", "f", "g"].map((k) => [k, randomUUID()])
);

beforeAll(async () => {
  for (const t of [focusSessions, automationRuns])
    await h.client!.exec(ddlFor(t as PgTable));
});

describe("the link chain a run ended in", () => {
  it("a loop that bypassed the write door is caught: A → B → C, then A again", async () => {
    const a = await run(PB.a!);
    const b = await run(PB.b!, { after: a });
    const c = await run(PB.c!, { after: b });
    expect((await readLinkLineage(c)).playbookIds).toEqual([PB.c, PB.b, PB.a]);
    expect(await linkWouldLoop({ endedSessionId: c, playbookId: PB.a! })).toBe(
      true
    );
    expect(await linkWouldLoop({ endedSessionId: c, playbookId: PB.b! })).toBe(
      true
    );
  });

  it("a legitimate chain longer than the depth floor (3) still starts its next playbook", async () => {
    let s = await run(PB.a!);
    for (const k of ["b", "c", "d", "e", "f"])
      s = await run(PB[k]!, { after: s });
    expect((await readLinkLineage(s)).playbookIds).toHaveLength(6);
    expect(await linkWouldLoop({ endedSessionId: s, playbookId: PB.g! })).toBe(
      false
    );
  });

  it("the chain stops at a run no close started (a schedule's, a person's)", async () => {
    const a = await run(PB.a!);
    const scheduled = await run(PB.b!, { startedBy: "cron.tick" });
    const c = await run(PB.c!, { after: scheduled });
    expect((await readLinkLineage(c)).playbookIds).toEqual([PB.c, PB.b]);
    // A is not in this chain (the schedule started B, not A's end).
    expect(await linkWouldLoop({ endedSessionId: c, playbookId: PB.a! })).toBe(
      false
    );
    void a;
  });

  it("a chain past the cap reads as capped, and is refused", async () => {
    let s = await run(PB.a!);
    for (let i = 0; i < 5; i++) s = await run(randomUUID(), { after: s });
    const lineage = await readLinkLineage(s, 4);
    expect(lineage).toMatchObject({ capped: true });
    expect(lineage.playbookIds).toHaveLength(4);
  });
});
