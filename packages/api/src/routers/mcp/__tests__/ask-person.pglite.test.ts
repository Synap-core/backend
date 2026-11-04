/**
 * `synap_ask_person` END TO END on PGlite — the one door any AI uses to put an
 * item in front of the person (founder, 2026-11-04: "one store, two roles").
 *
 * Real: the MCP handler, the attribution resolver an MCP call goes through
 * (`resolveSessionHandle` → `resolveWorkSession`, under the request's client
 * key), `createFocusSession` (the agent's standing asks session),
 * `updateFocusSession` (THE owed-ask write), the needs-you producer
 * (`notifySessionNeedsYou`), the owed read's projection (`projectOwedSlots`)
 * and the needs-you signal (`signalFromOwedSlot`). Stubbed: governance
 * (granted — its own suites), the session room, realtime, block guidance,
 * project placement, side-effect events, and the notification WRITE
 * (recorded, so the test reads the row the producer asked for).
 *
 *   - no session for this conversation → the agent's ONE standing "Asks from"
 *     session (no criteria asked), reused by its next conversation;
 *   - the stored ask is the SAME row `synap_update_session` writes;
 *   - a conversation with a session → the ask lands on it;
 *   - the same `dedupeKey` → that ask is updated, never a second one;
 *   - an ended session named, or a malformed ask → refused, nothing filed;
 *   - the priority: on the notification row (existing scale) and on the
 *     needs-you signal derived from what was stored.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    notified: [] as Array<Record<string, unknown>>,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock(
  "../../../services/focus-sessions/ensure-session-channel.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock(
  "../../../services/focus-sessions/block-guidelines.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    guidanceForBlockedSlots: async () => undefined,
  })
);
// The REAL needs-you producer runs; only the notification write is recorded.
vi.mock("../../../notifications/NotificationService.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    NotificationService: {
      ...(actual.NotificationService as object),
      create: async (input: Record<string, unknown>) => {
        h.notified.push(input);
        return "n-1";
      },
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("../../../services/focus-sessions/session-nudges.js", () => ({
  loadSessionNudges: async () => undefined,
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithClientKey } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";

// `update-session` FIRST (see `session-update-outcomes-no-session-id`): loaded
// through the handler instead, the permission-check mock resolves to the
// original and the real gate runs against PGlite.
await import("../../../services/focus-sessions/update-session.js");
const { askPersonHandlers } = await import("../handlers/ask-person.js");
const { sessionHandlers } = await import("../handlers/session.js");
const { resolveSessionHandle } = await import("../handlers/shared.js");
const { projectOwedSlots } =
  await import("../../../services/focus-sessions/owed-outputs.js");
const { signalFromOwedSlot } =
  await import("../../../services/signals/needs-you-union.js");

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
/** A claude.ai conversation with no session (an outside AI). */
const OUTSIDE = "key:k1|conv:claude-ai:outside";
/** A Claude Code conversation that started its own session. */
const INSIDE = "key:k1|conv:claude-code:inside";

const IN_TWO_DAYS = new Date(Date.now() + 2 * 86_400_000).toISOString();

const ASK = {
  mode: "confirm",
  prompt: "Publish the launch post today?",
  yes: { label: "Publish", recommended: true },
};

const slotsOf = async (id: string): Promise<ExpectedOutput[]> =>
  (
    await q<{ expected_outputs: ExpectedOutput[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;

const sessionCount = async () =>
  Number(
    (await q<{ n: string }>(`select count(*)::int as n from focus_sessions`))
      .rows[0]!.n
  );

/** One MCP call as the adapter makes it: attribution, then the handler. */
const askPerson = (clientKey: string, args: Record<string, unknown>) =>
  runWithClientKey(clientKey, async () => {
    const resolution = await resolveSessionHandle(
      "synap_ask_person",
      args,
      USER,
      AGENT
    );
    const res = (await askPersonHandlers.synap_ask_person!({
      toolName: "synap_ask_person",
      args,
      userId: USER,
      agentUserId: AGENT,
      sessionId: resolution?.session?.sessionId,
      apiKeyScopes: ["mcp.write", "mcp.read"],
      workspaceAccessible: false,
      caller: {} as never,
      lensCaller: {} as never,
    } as never)) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  });

async function seedSession(opts: {
  clientKey: string;
  title: string;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, criteria, agent_ids, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, '[]'::jsonb, '[]'::jsonb, $6, $7::jsonb, 'agent', now(), now(), now())`,
    [
      id,
      USER,
      opts.title,
      opts.title,
      opts.status ?? "active",
      `{${AGENT}}`,
      JSON.stringify({ clientKey: opts.clientKey }),
    ]
  );
  return id;
}

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table the generator cannot express is not read by these doors.
      }
    }
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human'), ($2, 'bot@x.test', 'Claude', 'agent')`,
    [USER, AGENT]
  );
}, 120_000);

describe("synap_ask_person, on PGlite", () => {
  let standing: string;

  it("an AI with no session files ONE owed ask on its standing asks session — no goal or criteria asked of it", async () => {
    const before = await sessionCount();
    const out = await askPerson(OUTSIDE, {
      question: "Publish the launch post today?",
      ask: ASK,
      why: "The post is drafted and scheduled for 17:00",
      consequence: "Publishes the post to LinkedIn",
      reversible: false,
      answerBy: IN_TWO_DAYS,
    });
    expect(out).toMatchObject({ status: "asked", filedOn: "standing" });
    expect(out.reasonCode).toBeUndefined();
    standing = out.sessionId as string;
    expect(await sessionCount()).toBe(before + 1);

    const [row] = (
      await q<{ title: string; criteria: unknown[] }>(
        `select title, criteria from focus_sessions where id = $1`,
        [standing]
      )
    ).rows;
    expect(row).toMatchObject({ title: "Asks from Claude", criteria: [] });

    const slots = await slotsOf(standing);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: "ask",
      label: "Publish the launch post today?",
      owner: "human",
      blockedReason: "decision",
      why: "The post is drafted and scheduled for 17:00",
      askedBy: AGENT,
      ask: {
        mode: "confirm",
        consequence: "Publishes the post to LinkedIn",
        reversible: false,
        answerBy: IN_TWO_DAYS,
      },
    });
    expect(slots[0]!.owedSince).toEqual(expect.any(String));
    // The person is told through the SAME producer update_session uses, and
    // the row carries the P-level on the EXISTING scale (P1 = high).
    expect(h.notified).toContainEqual(
      expect.objectContaining({
        type: "session.needs_you",
        sourceId: standing,
        priority: "high",
      })
    );
  });

  it("the same agent's NEXT conversation lands on the same standing session — never one session (and one push window) per ask", async () => {
    const before = await sessionCount();
    const out = await askPerson("key:k1|conv:claude-ai:another-chat", {
      question: "Which photo for the post?",
      ask: {
        mode: "choose",
        options: [{ label: "A", recommended: true }, { label: "B" }],
      },
    });
    expect(out).toMatchObject({
      status: "asked",
      filedOn: "standing",
      sessionId: standing,
    });
    expect(await sessionCount()).toBe(before);
    expect((await slotsOf(standing)).map((s) => s.label)).toEqual([
      "Publish the launch post today?",
      "Which photo for the post?",
    ]);
  });

  it("ONE STORE: the row is the one synap_update_session writes for the same owed ask", async () => {
    const other = await seedSession({
      clientKey: "key:k1|conv:claude-code:twin",
      title: "Twin",
    });
    const res = (await runWithClientKey("key:k1|conv:claude-code:twin", () =>
      sessionHandlers.synap_update_session!({
        toolName: "synap_update_session",
        args: {
          sessionId: other,
          outcomes: [
            {
              kind: "ask",
              label: "Publish the launch post today?",
              owner: "human",
              blockedReason: "decision",
              why: "The post is drafted and scheduled for 17:00",
              ask: {
                ...ASK,
                consequence: "Publishes the post to LinkedIn",
                reversible: false,
                answerBy: IN_TWO_DAYS,
              },
            },
          ],
        },
        userId: USER,
        agentUserId: AGENT,
        apiKeyScopes: ["mcp.write", "mcp.read"],
        workspaceAccessible: false,
        caller: {} as never,
        lensCaller: {} as never,
      } as never)
    )) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({
      status: "updated",
    });
    const strip = (s: ExpectedOutput | undefined) => {
      const { owedSince: _o, ...rest } = (s ?? {}) as ExpectedOutput & {
        owedSince?: string;
      };
      return rest;
    };
    const [viaUpdate] = await slotsOf(other);
    const viaAskPerson = (await slotsOf(standing)).find(
      (s) => s.label === "Publish the launch post today?"
    );
    expect(viaAskPerson).toBeDefined();
    expect(strip(viaAskPerson)).toEqual(strip(viaUpdate));
  });

  it("a conversation with its own session: the ask lands on THAT session, through the pod's attribution", async () => {
    const inside = await seedSession({ clientKey: INSIDE, title: "Work map" });
    const before = await sessionCount();
    const out = await askPerson(INSIDE, {
      question: "Which region first?",
      ask: {
        mode: "choose",
        options: [{ label: "EU", recommended: true }, { label: "US" }],
      },
    });
    expect(out).toMatchObject({
      status: "asked",
      filedOn: "attributed",
      sessionId: inside,
    });
    expect(await sessionCount()).toBe(before);
    expect((await slotsOf(inside)).map((s) => s.label)).toEqual([
      "Which region first?",
    ]);
  });

  it("the same dedupeKey UPDATES the agent's open ask — one card, wherever it was filed", async () => {
    // Filed on the conversation's own session…
    const home = await seedSession({
      clientKey: "key:k1|conv:claude-code:dedupe-1",
      title: "Domains",
    });
    const first = await askPerson("key:k1|conv:claude-code:dedupe-1", {
      question: "Renew the domain?",
      ask: { mode: "confirm" },
      dedupeKey: "domain-renewal",
    });
    expect(first).toMatchObject({ status: "asked", sessionId: home });
    const before = await sessionCount();
    const standingBefore = (await slotsOf(standing)).length;
    // …asked again from another conversation, reworded: the same ask.
    const again = await askPerson("key:k1|conv:claude-ai:dedupe-2", {
      question: "Renew synap.live for 2 years?",
      ask: { mode: "confirm" },
      dedupeKey: "domain-renewal",
      urgency: "whenever",
    });
    expect(again).toMatchObject({
      status: "updated",
      filedOn: "dedupe",
      sessionId: home,
    });
    expect(await sessionCount()).toBe(before);
    expect((await slotsOf(standing)).length).toBe(standingBefore);
    const slots = await slotsOf(home);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      label: "Renew synap.live for 2 years?",
      ask: { dedupeKey: "domain-renewal", urgency: "whenever" },
    });
  });

  it("refuses an ended session it names, and a malformed ask — nothing filed", async () => {
    const ended = await seedSession({
      clientKey: "key:k1|conv:claude-code:ended",
      title: "Old",
      status: "closed",
    });
    const before = await sessionCount();
    const standingBefore = (await slotsOf(standing)).length;
    const closed = await askPerson("key:k1|conv:claude-code:ended", {
      sessionId: ended,
      question: "Still there?",
      ask: { mode: "confirm" },
    });
    expect(String(closed.error)).toContain("NOTHING WAS FILED");
    expect(await slotsOf(ended)).toEqual([]);

    const bad = await askPerson(OUTSIDE, {
      question: "When?",
      ask: { mode: "confirm" },
      urgency: "asap",
    });
    expect(String(bad.error)).toContain("NOTHING WAS FILED");
    const noAsk = await askPerson(OUTSIDE, { question: "When?" });
    expect(String(noAsk.error)).toContain("NOTHING WAS FILED");
    expect(await sessionCount()).toBe(before);
    expect((await slotsOf(standing)).length).toBe(standingBefore);
  });

  it("the priority reaches the notification row and the needs-you read from what the door stored", async () => {
    h.notified.length = 0;
    const out = await askPerson("key:k1|conv:claude-ai:soon", {
      question: "Approve the hotfix deploy?",
      ask: { mode: "confirm", stakes: "commitment" },
      answerBy: new Date(Date.now() + 20 * 60_000).toISOString(),
    });
    expect(out).toMatchObject({ status: "asked", expectedPriority: "P0" });
    // P0 = urgent on the existing notifications.priority scale.
    expect(h.notified).toContainEqual(
      expect.objectContaining({ type: "session.needs_you", priority: "urgent" })
    );
    const [row] = (
      await q<{
        id: string;
        goal: string;
        status: string;
        expected_outputs: ExpectedOutput[];
      }>(
        `select id, goal, status, expected_outputs from focus_sessions where id = $1`,
        [out.sessionId]
      )
    ).rows;
    const owed = projectOwedSlots({
      id: row!.id,
      goal: row!.goal,
      status: row!.status,
      workspaceId: null,
      projectId: null,
      expectedOutputs: row!.expected_outputs,
      // The agent asked and stopped ten minutes ago: the headline.
      lastAgentActivityAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      lastAgentWorkAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      turnInFlight: false,
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    } as never).find((s) => s.label === "Approve the hotfix deploy?");
    const signal = signalFromOwedSlot(owed!);
    expect(signal.needsYouClass).toBe("needs_you");
    expect(signal.priority).toBe("P0");
  });
});
