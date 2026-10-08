/**
 * The external-agent status poll, read back out of PGlite.
 *
 *   - the normalizer: a recognized state maps; an unknown one is `null`
 *     (unreadable — never guessed);
 *   - IDEMPOTENT: one post per state change; an unchanged state posts nothing;
 *   - needs_input ⇒ a QUESTION card posted AS the agent;
 *   - done ⇒ the run capture (completed) and polling stops;
 *   - a binding without a status verb is never polled;
 *   - a proposed status read pauses polling while its proposal is pending.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  calls: [] as Array<Record<string, unknown>>,
  posts: [] as Array<Record<string, unknown>>,
  next: null as null | Record<string, unknown>,
  /** Runs INSIDE the status call — a concurrent write racing the tick. */
  during: null as null | (() => Promise<void>),
  /** Makes the NEXT run capture throw (a DB error mid-capture). */
  captureThrowsOnce: false,
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
        users: actual.users as never,
        links: actual.links as never,
        tools: actual.tools as never,
        focusSessions: actual.focusSessions as never,
        playbookRuns: actual.playbookRuns as never,
        proposals: actual.proposals as never,
        entities: actual.entities as never,
      },
    }),
  };
});
vi.mock("@synap/jobs", () => ({
  settleParentAutomationRunFromChild: async () => undefined,
}));
vi.mock("../../capabilities/execute-capability.js", () => ({
  executeCapability: async (input: Record<string, unknown>) => {
    h.calls.push(input);
    if (h.during) await h.during();
    return (
      h.next ?? { kind: "run", skillId: "s", result: { state: "running" } }
    );
  },
}));
vi.mock("../../runs/apply-run-capture.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../runs/apply-run-capture.js")>();
  return {
    ...real,
    applyRunCapture: async (
      ...args: Parameters<typeof real.applyRunCapture>
    ) => {
      if (h.captureThrowsOnce) {
        h.captureThrowsOnce = false;
        throw new Error("db down mid-capture");
      }
      return real.applyRunCapture(...args);
    },
  };
});
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: async (p: Record<string, unknown>) => {
    h.posts.push(p);
    return { success: true, messageId: "m" };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  links,
  tools,
  focusSessions,
  playbookRuns,
  proposals,
  entities,
} from "@synap/database";
import {
  AGENT_APPROVAL_SLOT_KIND,
  agentApprovalSlotLabel,
  normalizeExternalAgentStatus,
  pollExternalAgentRuns,
  statusKey,
} from "../poll-external-agents.js";
import { applyRunCapture } from "../../runs/apply-run-capture.js";

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

const OWNER = randomUUID();
const POLLED = randomUUID();
const NO_STATUS = randomUUID();

async function bindAgent(agent: string, withStatus: boolean) {
  const tool = randomUUID();
  await q(
    `insert into tools (id, created_by, name, kind, executor, config, status) values ($1, $2, 't', 'external', 'external-agent', $3::jsonb, 'active')`,
    [
      tool,
      OWNER,
      JSON.stringify({
        agentBinding: {
          protocol: "a2a",
          provider: "acme",
          supports: { push: false, inputRequired: true, cancel: false },
          verbs: {
            start: "x_start",
            send: "x_send",
            ...(withStatus ? { status: "x_status" } : {}),
          },
        },
      }),
    ]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
    [randomUUID(), agent, tool]
  );
}

async function dispatchedRun(agentUserId: string) {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, metadata, criteria, channel_id) values ($1, $2, 'g', 'active', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, $3)`,
    [sessionId, OWNER, randomUUID()]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, external_agent, started_at)
     values ($1, $2, $3, 'external-agent', 'running', '{}'::jsonb, $4, $5::jsonb, now())`,
    [
      runId,
      randomUUID(),
      sessionId,
      OWNER,
      JSON.stringify({
        agentUserId,
        toolId: "t",
        provider: "acme",
        externalId: "task-1",
        url: null,
        status: "running",
        startedAt: new Date().toISOString(),
      }),
    ]
  );
  return runId;
}
const runRow = async (id: string) =>
  (
    await q<{
      status: string;
      summary: string | null;
      external_agent: Record<string, unknown>;
    }>(
      `select status, summary, external_agent from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;
const ran = (state: Record<string, unknown>) => {
  h.next = { kind: "run", skillId: "s", result: state };
};

describe("external agent status poll", () => {
  beforeAll(async () => {
    for (const t of [
      users,
      links,
      tools,
      focusSessions,
      playbookRuns,
      proposals,
      entities,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'o@x', 'O', 'UTC', 'human', null),
        ($2, 'p@x', 'P', 'UTC', 'agent', 'p'),
        ($3, 'n@x', 'N', 'UTC', 'agent', 'n')`,
      [OWNER, POLLED, NO_STATUS]
    );
    await bindAgent(POLLED, true);
    await bindAgent(NO_STATUS, false);
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    h.calls.length = 0;
    h.posts.length = 0;
    h.next = null;
    h.during = null;
    h.captureThrowsOnce = false;
    // Each test starts with no live dispatched run left over.
    await q(`update playbook_runs set status = 'completed'`);
  });

  it("normalizes a recognized state and refuses an unknown one", () => {
    expect(
      normalizeExternalAgentStatus({
        state: "needs_input",
        summary: "Which DB?",
        prUrl: "https://gh/pr/1",
        extra: 1,
      })
    ).toEqual({
      state: "needs_input",
      summary: "Which DB?",
      prUrl: "https://gh/pr/1",
    });
    expect(normalizeExternalAgentStatus({ state: "thinking" })).toBeNull();
    expect(normalizeExternalAgentStatus(null)).toBeNull();
    expect(statusKey({ state: "running" })).not.toBe(
      statusKey({ state: "running", prUrl: "x" })
    );
  });

  it("posts ONCE per state change; an unchanged state posts nothing", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "running", branch: "feat/x" });
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      verbId: "x_status",
      agentUserId: POLLED,
      userId: OWNER,
      observability: "mirror",
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ agentUserId: POLLED, kind: "update" });
    expect(h.posts[0]!.content).toBe("Pushed a branch");

    await pollExternalAgentRuns(); // same state
    expect(h.calls).toHaveLength(2);
    expect(h.posts).toHaveLength(1);

    ran({ state: "running", branch: "feat/x", prUrl: "https://gh/pr/9" });
    await pollExternalAgentRuns(); // changed
    expect(h.posts).toHaveLength(2);
    // Short, and the link stays on the section — never in the prose.
    expect(h.posts[1]!.content).toBe("Opened pull request");
    expect((await runRow(runId)).status).toBe("running");
  });

  it("a SUMMARY-only change updates the section but posts nothing; done/failed lines are short and link-free", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "running", summary: "Reading the code" });
    await pollExternalAgentRuns();
    expect(h.posts.map((p) => p.content)).toEqual(["Working"]);
    ran({ state: "running", summary: "Writing the tests" });
    await pollExternalAgentRuns();
    expect(h.posts).toHaveLength(1);
    expect(
      ((await runRow(runId)).external_agent.lastState as { summary: string })
        .summary
    ).toBe("Writing the tests");
    ran({
      state: "failed",
      summary: "Tests failed: see https://ci.example/run/1\nlots more log",
    });
    await pollExternalAgentRuns();
    expect(h.posts.at(-1)!.content).toBe("Failed: Tests failed: see");
    const done = await dispatchedRun(POLLED);
    ran({ state: "done", summary: "Shipped", prUrl: "https://gh/pr/3" });
    await pollExternalAgentRuns();
    expect(h.posts.at(-1)!.content).toBe("Finished");
    expect((await runRow(done)).status).toBe("completed");
  });

  it("a failed status read counts a streak on the run (first seen + count); the next good read clears it", async () => {
    const runId = await dispatchedRun(POLLED);
    // A first good read, so the read after the streak is UNCHANGED (no claim).
    ran({ state: "running" });
    await pollExternalAgentRuns();
    h.next = { kind: "error", message: "502 Bad Gateway" };
    await pollExternalAgentRuns();
    await pollExternalAgentRuns();
    await pollExternalAgentRuns();
    const err = (await runRow(runId)).external_agent.pollError as {
      firstSeenAt: string;
      count: number;
      message: string;
    };
    expect(err.count).toBe(3);
    expect(err.message).toBe("502 Bad Gateway");
    expect(typeof err.firstSeenAt).toBe("string");
    // An unchanged good read (no claim) still clears it.
    ran({ state: "running" });
    await pollExternalAgentRuns();
    expect((await runRow(runId)).external_agent).not.toHaveProperty(
      "pollError"
    );
    // A changed good read (the claim) clears it too.
    h.next = { kind: "error", message: "502" };
    await pollExternalAgentRuns();
    ran({ state: "running", prUrl: "https://gh/pr/5" });
    await pollExternalAgentRuns();
    expect((await runRow(runId)).external_agent).not.toHaveProperty(
      "pollError"
    );
    // A streak is never written over a verdict.
    h.next = { kind: "error", message: "down" };
    h.during = async () => {
      await q(`update playbook_runs set status = 'cancelled' where id = $1`, [
        runId,
      ]);
    };
    await pollExternalAgentRuns();
    expect((await runRow(runId)).external_agent).not.toHaveProperty(
      "pollError"
    );
  });

  it("an output's first-seen time is kept across polls; a changed output gets a new one", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "running", prUrl: "https://gh/pr/1", branch: "b1" });
    await pollExternalAgentRuns();
    const first = (await runRow(runId)).external_agent.reportedAt as Record<
      string,
      string
    >;
    expect(Object.keys(first).sort()).toEqual(["branch", "prUrl"]);
    await new Promise((r) => setTimeout(r, 5));
    ran({
      state: "running",
      prUrl: "https://gh/pr/1",
      branch: "b2",
      summary: "x",
    });
    await pollExternalAgentRuns();
    const second = (await runRow(runId)).external_agent.reportedAt as Record<
      string,
      string
    >;
    expect(second.prUrl).toBe(first.prUrl);
    expect(second.branch).not.toBe(first.branch);
  });

  it("needs_input ⇒ a QUESTION card posted as the agent", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "needs_input", summary: "Postgres or SQLite?" });
    await pollExternalAgentRuns();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({
      agentUserId: POLLED,
      kind: "question",
      content: "Postgres or SQLite?",
    });
    expect((await runRow(runId)).external_agent.status).toBe("needs_input");
  });

  it("needs_input on a waiting tool call ⇒ an APPROVAL card: an owed confirm slot, and the card carries the call's id", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({
      state: "needs_input",
      summary: "Approve running github.push_files?",
      confirmationId: "sevt_push",
    });
    await pollExternalAgentRuns();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({
      agentUserId: POLLED,
      kind: "question",
      slotLabel: agentApprovalSlotLabel("acme"),
      ask: { mode: "confirm" },
      providerConfirmationId: "sevt_push",
    });
    const sessionId = (
      await q<{ session_id: string }>(
        `select session_id from playbook_runs where id = $1`,
        [runId]
      )
    ).rows[0]!.session_id;
    const slots = (
      await q<{ expected_outputs: Array<Record<string, unknown>> }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.expected_outputs;
    expect(slots).toEqual([
      expect.objectContaining({
        kind: AGENT_APPROVAL_SLOT_KIND,
        label: agentApprovalSlotLabel("acme"),
        owner: "human",
        ask: expect.objectContaining({ mode: "confirm" }),
      }),
    ]);
    expect((await runRow(runId)).external_agent.lastState).toMatchObject({
      confirmationId: "sevt_push",
    });

    // The NEXT waiting call re-owes the card (one slot, not two) and names it.
    ran({
      state: "needs_input",
      summary: "Approve running github.merge_pull_request?",
      confirmationId: "sevt_merge",
    });
    await pollExternalAgentRuns();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toMatchObject({ providerConfirmationId: "sevt_merge" });
    const after = (
      await q<{ expected_outputs: unknown[] }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.expected_outputs;
    expect(after).toHaveLength(1);
  });

  it("a plain needs_input (no waiting call) is a free question — no slot, no confirmation id", async () => {
    await dispatchedRun(POLLED);
    ran({ state: "needs_input", summary: "Which DB?" });
    await pollExternalAgentRuns();
    expect(h.posts[0]).not.toHaveProperty("providerConfirmationId");
    expect(h.posts[0]).not.toHaveProperty("slotLabel");
  });

  it("done ⇒ the run capture lands (completed) and polling stops", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({
      state: "done",
      summary: "Shipped the page",
      prUrl: "https://gh/pr/2",
    });
    await pollExternalAgentRuns();
    const row = await runRow(runId);
    expect(row.status).toBe("completed");
    expect(row.summary).toBe("Shipped the page");
    expect(row.external_agent.status).toBe("done");
    h.calls.length = 0;
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(0);
  });

  it("a capture that THROWS releases the claim — the next tick retries and the run completes", async () => {
    const runId = await dispatchedRun(POLLED);
    ran({ state: "done", summary: "Shipped" });
    h.captureThrowsOnce = true;
    const first = await pollExternalAgentRuns();
    expect(first.failed).toBe(1);
    const stuck = await runRow(runId);
    expect(stuck.status).toBe("running");
    // The claim was released: the row is still selectable by the next tick.
    expect(stuck.external_agent.status).not.toBe("done");

    await pollExternalAgentRuns();
    const row = await runRow(runId);
    expect(row.status).toBe("completed");
    expect(row.summary).toBe("Shipped");
  });

  it("a CANCEL that lands while a tick is reading status is never overwritten (done / running)", async () => {
    for (const state of ["done", "running"] as const) {
      const runId = await dispatchedRun(POLLED);
      ran({ state, summary: "late news" });
      h.during = async () => {
        // What cancelRun writes: the run AND its external ref, cancelled.
        await q(
          `update playbook_runs set status = 'cancelled', external_agent = jsonb_set(external_agent, '{status}', '"cancelled"') where id = $1`,
          [runId]
        );
      };
      h.posts.length = 0;
      await pollExternalAgentRuns();
      const row = await runRow(runId);
      expect(row.status, state).toBe("cancelled");
      expect(row.external_agent.status, state).toBe("cancelled");
      expect(row.summary, state).not.toBe("late news");
      expect(h.posts, state).toHaveLength(0);
    }
  });

  it("applyRunCapture: a terminal capture from a STALE copy never overwrites a cancelled run", async () => {
    const runId = await dispatchedRun(POLLED);
    const [stale] = (
      await q<Record<string, unknown>>(
        `select id, status, summary, error, completed_at as "completedAt", session_id as "sessionId", workspace_id as "workspaceId" from playbook_runs where id = $1`,
        [runId]
      )
    ).rows;
    await q(`update playbook_runs set status = 'cancelled' where id = $1`, [
      runId,
    ]);
    const out = await applyRunCapture({
      run: stale as never,
      status: "completed",
      summary: "overwrite?",
    });
    expect(out).toBeNull();
    const row = await runRow(runId);
    expect(row.status).toBe("cancelled");
    expect(row.summary).not.toBe("overwrite?");
  });

  it("applyRunCapture: a late NON-terminal (running) capture never revives a cancelled or failed run", async () => {
    for (const verdict of ["cancelled", "failed", "completed"] as const) {
      const runId = await dispatchedRun(POLLED);
      const [stale] = (
        await q<Record<string, unknown>>(
          `select id, status, summary, error, completed_at as "completedAt", session_id as "sessionId", workspace_id as "workspaceId" from playbook_runs where id = $1`,
          [runId]
        )
      ).rows;
      await q(`update playbook_runs set status = $2 where id = $1`, [
        runId,
        verdict,
      ]);
      const out = await applyRunCapture({
        run: stale as never,
        status: "running",
        summary: "still at it",
      });
      expect(out, verdict).toBeNull();
      const row = await runRow(runId);
      expect(row.status, verdict).toBe(verdict);
      expect(row.summary, verdict).not.toBe("still at it");
    }
  });

  it("a run whose binding has NO status verb never starves the others (least-recently polled first)", async () => {
    await dispatchedRun(NO_STATUS); // inserted first — first in heap order
    await dispatchedRun(POLLED);
    ran({ state: "running" });
    await pollExternalAgentRuns({ limit: 1 });
    await pollExternalAgentRuns({ limit: 1 });
    // Two one-run ticks visit BOTH runs: the status-verb run was read once.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ verbId: "x_status" });
  });

  it("the NEVER-polled run goes first, whatever the table's physical order", async () => {
    const fresh = await dispatchedRun(POLLED);
    const neverPolled = await dispatchedRun(NO_STATUS);
    // Physical order after these writes: neverPolled, fresh — then fresh is
    // rewritten as polled, then neverPolled is rewritten LAST (still unpolled).
    await q(
      `update playbook_runs set external_agent = jsonb_set(external_agent, '{polledAt}', '"2026-01-01T00:00:00.000Z"') where id = $1`,
      [fresh]
    );
    await q(
      `update playbook_runs set external_agent = external_agent - 'polledAt' where id = $1`,
      [neverPolled]
    );
    ran({ state: "running" });
    await pollExternalAgentRuns({ limit: 1 });
    expect(h.calls).toHaveLength(0); // the unpolled (no-status) run was visited
    await pollExternalAgentRuns({ limit: 1 });
    expect(h.calls).toHaveLength(1);
  });

  it("a binding without a status verb is never polled", async () => {
    await dispatchedRun(NO_STATUS);
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });

  it("a PROPOSED status read pauses polling while its proposal is pending", async () => {
    const runId = await dispatchedRun(POLLED);
    const proposalId = randomUUID();
    await q(`insert into proposals (id, status) values ($1, 'pending')`, [
      proposalId,
    ]);
    h.next = {
      kind: "proposed",
      proposalId,
      reviewUrl: "https://pod/open/x",
      ackState: "pending",
    };
    await pollExternalAgentRuns();
    expect((await runRow(runId)).external_agent.pollBlockedBy).toBe(proposalId);
    h.calls.length = 0;
    await pollExternalAgentRuns();
    expect(h.calls).toHaveLength(0);
  });
});
