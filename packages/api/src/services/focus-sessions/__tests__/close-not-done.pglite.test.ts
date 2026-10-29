/**
 * "Done" is checked, not claimed (F11, `close-not-done.ts`) — driven through
 * the real MCP handler, the real Hub `/complete` door and the real close
 * service, read back out of PGlite.
 *
 * Each test names the rule it rules out:
 *   - an agent's `closed` going through while a required criterion is
 *     ungraded or failed, or while a required outcome it owns is open (the
 *     self-reported "done" of pod document 9ca0c96b §3.3);
 *   - a refusal that does not say WHAT is left (the agent cannot act on it);
 *   - an override `reason` that closes but is not recorded;
 *   - the check reaching closes it must never block: the person's own close,
 *     `cancelled`, `failed`, and outcomes the agent does not owe (the
 *     person's, optional, withdrawn ones): the discriminating rows;
 *   - a passing criterion still refusing (the check reading the wrong verdict).
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose`: granted — the
 * membrane is not under test, the refusal comes BEFORE it), and the transport
 * seams of `close-door-refusals.pglite.test.ts` (sockets, Expo, the event
 * history row, channel visibility).
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
        notifications: actual.notifications as never,
        users: actual.users as never,
        channels: actual.channels as never,
        channelMembers: actual.channelMembers as never,
        messages: actual.messages as never,
        sessionEvaluations: actual.sessionEvaluations as never,
        playbookRuns: actual.playbookRuns as never,
        entities: actual.entities as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async () => undefined,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { allSchemaTables } from "../../../__tests__/pglite-ddl.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "44444444-4444-4444-8444-444444444444";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "timestamp" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of allSchemaTables()) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, email, name, timezone, user_type, agent_type) values
      ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
      ($2, 'c@example.test', 'Claude Code', 'UTC', 'agent', 'claude-code')`,
    [OWNER, AGENT]
  );
}, 120_000);
afterAll(async () => h.client?.close());

const CRITERION = {
  key: "tests-pass",
  statement: "The new tests pass on the devbox",
  check: { kind: "evidence", evidenceKey: "tests" },
};

async function seed(p: {
  criteria?: unknown[];
  outputs?: unknown[];
  withRoom?: boolean;
}): Promise<string> {
  const id = randomUUID();
  let channelId: string | null = null;
  if (p.withRoom) {
    channelId = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Ship', now(), now())`,
      [channelId, OWNER]
    );
  }
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', 'Ship', 'active', $3::jsonb, $4, '{}'::jsonb, $5::jsonb, $6, now(), now(), now())`,
    [
      id,
      OWNER,
      JSON.stringify(p.outputs ?? []),
      [AGENT],
      JSON.stringify(p.criteria ?? []),
      channelId,
    ]
  );
  return id;
}

async function grade(
  sessionId: string,
  key: string,
  verdict: string,
  p: { kind?: string; attempt?: number } = {}
) {
  await q(
    `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evidence, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, now())`,
    [
      randomUUID(),
      sessionId,
      OWNER,
      key,
      p.attempt ?? 1,
      verdict,
      p.kind ?? "evidence",
    ]
  );
}

/** A pending proposal of the session that names a slot (pack mode). */
async function pendingProposalFor(sessionId: string, expectedKey: string) {
  await q(
    `insert into proposals (id, session_id, status, proposal_type, target_type, data, created_at, updated_at)
     values ($1, $2, 'pending', 'create', 'document', $3::jsonb, now(), now())`,
    [randomUUID(), sessionId, JSON.stringify({ expectedKey })]
  );
}

const rowOf = async (id: string) =>
  (
    await q<{
      status: string;
      verification_report: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
    }>(
      `select status, verification_report, metadata from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

async function mcpClose(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { sessionHandlers } =
    await import("../../../routers/mcp/handlers/session.js");
  const res = await sessionHandlers.synap_complete_session!({
    toolName: "synap_complete_session",
    args,
    userId: OWNER,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  return JSON.parse(
    (res.content as Array<{ text: string }>)[0]!.text
  ) as Record<string, unknown>;
}

function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("userId" as never, OWNER as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.write", "hub-protocol.read"] as never
    );
    c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerFocusSessionsRoutes(a as never);
  return a;
}
const hubComplete = (id: string, body: unknown) =>
  app().request(`/focus-sessions/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("an agent's close is checked against what the session owes", () => {
  it("refuses `closed` while a required criterion was never graded, naming it", async () => {
    const id = await seed({ criteria: [CRITERION] });
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      status: "refused",
      reasonCode: "NOT_DONE",
      unmetCriteria: [{ key: "tests-pass", verdict: "unmeasured" }],
      openOutcomes: [],
    });
    expect(String(body.error)).toContain("tests-pass");
    expect((await rowOf(id)).status).toBe("active");
  });

  it("refuses `closed` while a required criterion failed", async () => {
    const id = await seed({ criteria: [CRITERION] });
    await grade(id, "tests-pass", "fail");
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      reasonCode: "NOT_DONE",
      unmetCriteria: [{ key: "tests-pass", verdict: "fail" }],
    });
    expect((await rowOf(id)).status).toBe("active");
  });

  it("closes once the required criterion passes", async () => {
    const id = await seed({ criteria: [CRITERION] });
    await grade(id, "tests-pass", "pass");
    const body = await mcpClose({ sessionId: id });
    expect(body.status).toBe("closed");
    expect((await rowOf(id)).status).toBe("closed");
  });

  it("an optional criterion does not hold the close", async () => {
    const id = await seed({ criteria: [{ ...CRITERION, required: false }] });
    const body = await mcpClose({ sessionId: id });
    expect(body.status).toBe("closed");
  });

  it("refuses while a required outcome the agent owns is open, and lists only that one", async () => {
    const id = await seed({
      outputs: [
        { kind: "code", label: "Backend PR", status: "pending" },
        // The discriminating rows: none of these is owed by anyone any more.
        {
          kind: "doc",
          label: "Nice to have",
          status: "pending",
          optional: true,
        },
        {
          kind: "doc",
          label: "Withdrawn spec",
          status: "pending",
          retiredAt: "2026-10-29T00:00:00Z",
        },
        { kind: "doc", label: "Report", status: "done" },
      ],
    });
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      reasonCode: "NOT_DONE",
      unmetCriteria: [],
      openOutcomes: [{ key: "backend-pr", label: "Backend PR" }],
      owedByPerson: [],
    });
    expect(body.openOutcomes).toHaveLength(1);
    expect((await rowOf(id)).status).toBe("active");
  });

  it("an outcome the person still owes holds the close: wait, pause, or a reason", async () => {
    const id = await seed({
      outputs: [
        {
          kind: "decision",
          label: "Founder picks the default",
          status: "pending",
          owner: "human",
          ask: { mode: "confirm" },
        },
      ],
    });
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      reasonCode: "NOT_DONE",
      unmetCriteria: [],
      openOutcomes: [],
      owedByPerson: [
        {
          key: "founder-picks-the-default",
          label: "Founder picks the default",
        },
      ],
    });
    expect(String(body.error)).toContain("wait for the person");
    expect(String(body.error)).toContain("paused");
    expect((await rowOf(id)).status).toBe("active");

    const closed = await mcpClose({
      sessionId: id,
      reason: "The founder answered in chat; relayed",
    });
    expect(closed.status).toBe("closed");
    expect(closed.closedNotDone).toMatchObject({
      owedByPerson: [{ key: "founder-picks-the-default" }],
    });
  });

  it("an outcome-with-verify the person owes: its criterion waits, its slot holds the close", async () => {
    const id = await seed({
      criteria: [
        {
          key: "sign-off",
          statement: "Founder sign-off",
          check: { kind: "judge" },
        },
      ],
      outputs: [
        {
          key: "sign-off",
          kind: "decision",
          label: "Founder sign-off",
          status: "pending",
          owner: "human",
        },
      ],
    });
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      reasonCode: "NOT_DONE",
      unmetCriteria: [],
      owedByPerson: [{ key: "sign-off" }],
      waiting: {
        criteria: [{ key: "sign-off", waitingOn: "person_check" }],
      },
    });
  });

  it("an outcome delegated to another agent is still owed", async () => {
    const id = await seed({
      outputs: [
        {
          kind: "doc",
          label: "Delegated spec",
          status: "pending",
          delegatedTo: "codex",
        },
      ],
    });
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      reasonCode: "NOT_DONE",
      openOutcomes: [{ key: "delegated-spec", delegatedTo: "codex" }],
    });
  });

  it("with a `reason`, closes and records the reason and what was open", async () => {
    const id = await seed({
      criteria: [CRITERION],
      outputs: [{ kind: "code", label: "Backend PR", status: "pending" }],
    });
    const body = await mcpClose({
      sessionId: id,
      reason: "Merged as part of #510 instead",
    });
    expect(body.status).toBe("closed");
    expect(body.closedNotDone).toMatchObject({
      reason: "Merged as part of #510 instead",
      by: AGENT,
    });
    const row = await rowOf(id);
    expect(row.status).toBe("closed");
    expect(row.verification_report?.closedNotDone).toMatchObject({
      reason: "Merged as part of #510 instead",
      criteria: [{ key: "tests-pass" }],
      outcomes: [{ key: "backend-pr" }],
    });
    expect((body.warnings as string[]).join(" ")).toContain(
      "Merged as part of #510 instead"
    );
  });

  it("a blank `reason` is no reason", async () => {
    const id = await seed({ criteria: [CRITERION] });
    const body = await mcpClose({ sessionId: id, reason: "   " });
    expect(body.reasonCode).toBe("NOT_DONE");
    expect((await rowOf(id)).status).toBe("active");
  });

  it("`cancelled` and `failed` are never refused, and the cancel keeps its reason", async () => {
    const a = await seed({ criteria: [CRITERION] });
    const cancelled = await mcpClose({
      sessionId: a,
      terminalStatus: "cancelled",
      reason: "Superseded by the wave's lane L7",
    });
    expect(cancelled.status).toBe("cancelled");
    const meta = (await rowOf(a)).metadata as {
      run?: { cancel?: { reason?: string } };
    };
    expect(meta.run?.cancel?.reason).toBe("Superseded by the wave's lane L7");

    const b = await seed({ criteria: [CRITERION] });
    const failed = await mcpClose({ sessionId: b, terminalStatus: "failed" });
    expect(failed.status).toBe("failed");
  });

  it("what awaits the person's grade or review never refuses, and is listed in `waiting`", async () => {
    const id = await seed({
      criteria: [
        // The person checks it.
        {
          key: "looks-right",
          statement: "The founder says it reads right",
          check: { kind: "human" },
        },
        // Escalated: both non-human attempts spent, failing.
        {
          key: "judged",
          statement: "A judge reads it as done",
          check: { kind: "judge" },
        },
        // Already graded by the person (fail): the person's call now.
        {
          key: "graded",
          statement: "The founder graded it",
          check: { kind: "evidence", evidenceKey: "graded" },
        },
      ],
      outputs: [
        {
          kind: "code",
          label: "Claimed PR",
          status: "pending",
          claimedDone: true,
        },
        { key: "pack-doc", kind: "doc", label: "Pack doc", status: "pending" },
      ],
    });
    await grade(id, "graded", "fail", { kind: "human" });
    await grade(id, "judged", "fail", { kind: "judge", attempt: 1 });
    await grade(id, "judged", "fail", { kind: "judge", attempt: 2 });
    await pendingProposalFor(id, "pack-doc");

    const body = await mcpClose({ sessionId: id });
    expect(body.status).toBe("closed");
    const waiting = body.waiting as {
      criteria: Array<{ key: string; waitingOn: string }>;
      outcomes: Array<{ key: string; waitingOn: string }>;
    };
    expect(
      Object.fromEntries(waiting.criteria.map((c) => [c.key, c.waitingOn]))
    ).toEqual({
      "looks-right": "person_check",
      judged: "escalated",
      graded: "person_graded",
    });
    expect(
      Object.fromEntries(waiting.outcomes.map((o) => [o.key, o.waitingOn]))
    ).toEqual({
      "claimed-pr": "review",
      "pack-doc": "proposal",
    });
    expect((body.warnings as string[]).join(" ")).toContain(
      "Awaiting the person's grade or review"
    );
  });

  it("one non-human attempt left: the criterion is still the agent's", async () => {
    const id = await seed({
      criteria: [
        {
          key: "judged",
          statement: "A judge reads it as done",
          check: { kind: "judge" },
        },
      ],
    });
    await grade(id, "judged", "fail", { kind: "judge", attempt: 1 });
    const body = await mcpClose({ sessionId: id });
    expect(body).toMatchObject({
      reasonCode: "NOT_DONE",
      unmetCriteria: [{ key: "judged", verdict: "fail" }],
    });
  });

  it("malformed slots are skipped, never a 500", async () => {
    const id = await seed({
      outputs: [null, 7, { kind: "doc", status: "pending" }],
    });
    const body = await mcpClose({ sessionId: id });
    // The label-less slot still has a derived key and is the agent's: listed.
    expect(body.reasonCode === "NOT_DONE" || body.status === "closed").toBe(
      true
    );
    expect(body.error ?? "").not.toMatch(/Cannot read|undefined/);
  });

  it("a caller-sent closedNotDone is dropped; an explicit null report stays null", async () => {
    const a = await seed({});
    await mcpClose({
      sessionId: a,
      verificationReport: {
        closedNotDone: { reason: "forged" },
        checked: "tsc",
      },
    });
    expect((await rowOf(a)).verification_report).toEqual({ checked: "tsc" });

    const b = await seed({ criteria: [CRITERION] });
    const closed = await mcpClose({
      sessionId: b,
      verificationReport: null,
      reason: "Checked by hand",
    });
    expect(closed.status).toBe("closed");
    expect((await rowOf(b)).verification_report).toBeNull();
    expect(closed.closedNotDone).toMatchObject({ reason: "Checked by hand" });
  });

  it("the reason is clipped to 1000 characters and posted as one line in the room", async () => {
    const id = await seed({ criteria: [CRITERION], withRoom: true });
    const long = `Done another way ${"x".repeat(1200)}`;
    const body = await mcpClose({ sessionId: id, reason: long });
    expect(body.status).toBe("closed");
    const reason = (body.closedNotDone as { reason: string }).reason;
    expect(reason.length).toBe(1000);
    const room = await q<{ content: string; role: string }>(
      `select m.content, m.role from messages m join focus_sessions s on s.channel_id = m.channel_id where s.id = $1`,
      [id]
    );
    const line = room.rows.find((r) =>
      r.content.includes("Closed with required work still open")
    );
    expect(line?.role).toBe("system");
    expect(line?.content).toContain("Done another way");
    expect((body.warnings as string[]).join(" ")).not.toContain(
      "could not be posted"
    );
  });

  it("a cancel's reason is the cancel reason only, never a close-anyway record", async () => {
    const id = await seed({ criteria: [CRITERION] });
    const body = await mcpClose({
      sessionId: id,
      terminalStatus: "cancelled",
      reason: "Not needed",
    });
    expect(body.status).toBe("cancelled");
    expect(body.closedNotDone).toBeUndefined();
    expect(
      (await rowOf(id)).verification_report?.closedNotDone
    ).toBeUndefined();
  });

  it("the person's own close is never refused", async () => {
    const { completeFocusSession } = await import("../complete-session.js");
    const id = await seed({
      criteria: [CRITERION],
      outputs: [{ kind: "code", label: "Backend PR", status: "pending" }],
    });
    const result = await completeFocusSession({ sessionId: id, userId: OWNER });
    expect(result?.session.status).toBe("closed");
    expect(result?.closedNotDone).toBeUndefined();
  });

  it("Hub /complete answers the same refusal (409) and takes the same `reason`", async () => {
    const id = await seed({ criteria: [CRITERION] });
    const refused = await hubComplete(id, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      status: "refused",
      reasonCode: "NOT_DONE",
      unmetCriteria: [{ key: "tests-pass" }],
    });
    expect((await rowOf(id)).status).toBe("active");

    const viaPatch = await app().request(`/focus-sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(viaPatch.status).toBe(409);
    expect(await viaPatch.json()).toMatchObject({
      reasonCode: "NOT_DONE",
      unmetCriteria: [{ key: "tests-pass" }],
    });
    expect((await rowOf(id)).status).toBe("active");

    const closed = await hubComplete(id, { reason: "Checked by hand on prod" });
    expect(closed.status).toBe(200);
    expect((await rowOf(id)).verification_report?.closedNotDone).toMatchObject({
      reason: "Checked by hand on prod",
    });
  });
});
