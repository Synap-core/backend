/**
 * "You have an answer" reaches the agents that READ instead of being woken
 * (claude.ai, Raycast, Claude Code on its next turn): the REAL
 * `answerExpectedOutput` stamps a slot, then the REAL `projectContinuationPacket`
 * (MCP `synap_get_session`, Hub GET, tRPC get) and the REAL
 * `computeSessionNudges` (update/complete replies) read the stored row back.
 * Nothing is hand-built between the write and the read — that is the seam.
 *
 * Also pins the tRPC send door's wiring by source, because driving
 * `channels.sendMessage` needs the whole IS stack: the Hub twin of the same
 * call is driven behaviourally in `answer-loop.pglite.test.ts`. What the scan
 * CANNOT see: whether the guarded call is reached at runtime on every send
 * path (it asserts the call and its human-only guard exist, in that order).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
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
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  proposals,
  users,
  links,
  artifacts,
  entities,
  documents,
  views,
  automations,
  playbooks,
  projects,
  messages,
  workspaces,
  workspaceMembers,
  eq,
} from "@synap/database";
import { projectContinuationPacket } from "../continuation-packet.js";
import { computeSessionNudges } from "../session-nudges.js";
import { answerExpectedOutput } from "../answer-slot.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const SID = randomUUID();
const SLOTS = [
  { kind: "document", label: "Pricing page" },
  {
    kind: "document",
    label: "Stripe key",
    owner: "human",
    blockedReason: "decision",
    why: "EU or US account?",
    owedSince: "2026-09-25T09:00:00.000Z",
  },
];

async function row() {
  const [r] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, SID));
  return r!;
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    links,
    artifacts,
    entities,
    documents,
    views,
    automations,
    playbooks,
    projects,
    messages,
    workspaces,
    workspaceMembers,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, title, goal, status, expected_outputs, metadata, origin, criteria, created_at, updated_at, started_at)
     values ($1, $2, null, null, 'Ship billing', 'Bill customers', 'active', $3::jsonb, '{}'::jsonb, 'human', '[]'::jsonb, now(), now(), now())`,
    [SID, USER, JSON.stringify(SLOTS)]
  );
});

describe("an answer is visible to agents that read", () => {
  it("BEFORE: the slot is owed by the person, the agent has no answer", async () => {
    const p = await projectContinuationPacket(await row(), {
      database: db,
      userId: USER,
    });
    expect(p.userMustDecide.owedSlots).toMatchObject({ total: 1 });
    expect(p.nextMove.kind).toBe("owed_slot");
  });

  it("AFTER: the packet hands it to the AI, answer attached and FIRST; nextMove says continue", async () => {
    const r = await answerExpectedOutput({
      sessionId: SID,
      userId: USER,
      expectedLabel: "Stripe key",
      text: "EU account",
      messageId: null,
    });
    expect(r.status).toBe("answered");

    const p = await projectContinuationPacket(await row(), {
      database: db,
      userId: USER,
    });
    expect(p.userMustDecide.owedSlots).toMatchObject({ total: 0 });
    expect(p.aiCanDo.status).toBe("ok");
    if (p.aiCanDo.status !== "ok") return;
    expect(p.aiCanDo.items.map((i) => i.label)).toEqual([
      "Stripe key",
      "Pricing page",
    ]);
    expect(p.aiCanDo.items[0]!.answer).toMatchObject({
      text: "EU account",
      messageId: null,
    });
    expect(p.aiCanDo.items[1]!.answer).toBeUndefined();
    expect(p.nextMove).toMatchObject({
      kind: "agent_slot",
      actor: "ai",
      label: 'Continue "Stripe key"',
      reason: 'The person answered: "EU account"',
    });
  });

  it("the update/complete nudge names the answered output", async () => {
    const r = await row();
    const n = computeSessionNudges({
      session: { ...r, playbookId: "pb", origin: "playbook" },
      evaluation: {
        criteria: [{ key: "k", statement: "s", required: true } as never],
        evaluations: [{ criterionKey: "k", verdict: "pass" } as never],
      },
      phase: "update",
    });
    expect(n?.answered).toEqual(["Stripe key"]);
    expect(n?.hints.some((x) => x.includes('answered "Stripe key"'))).toBe(
      true
    );
  });

  it("the tRPC send door calls the answer loop, human-only, with the silence-derived wake", () => {
    const src = readFileSync(
      join(__dirname, "../../../routers/channels/send-message.ts"),
      "utf8"
    );
    const guard = src.indexOf("if (!input.ephemeral && !ctx.agentUserId) {");
    const call = src.indexOf("await recordOwnerRoomReply({", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
    // The wake is off whenever this send already starts a turn.
    expect(src.slice(call, call + 400)).toContain(
      "wake: staysSilent && !anchoredComment?.decision.trigger"
    );
  });
});
