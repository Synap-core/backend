/**
 * WHO ANSWERS IN A ROOM, and the "who should answer?" answer — read back out of
 * PGlite (`route-room.ts`):
 *   - when_confident, nobody named: the single house agent answers when the
 *     sender is the only PERSON in the room; with another person there the
 *     room stays silent (restraint — people talk to each other);
 *   - two house agents ⇒ choose; only_mentioned ⇒ silent; a mention picks;
 *   - an answer is claimed ONCE on the choice message: a second tap is refused
 *     and starts no turn; a turn that fails to start releases the claim.
 *
 * Real: the tables, route(), the room rule. Captured: the auto-respond door.
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
  turns: [] as Array<Record<string, unknown>>,
  start: true,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.turns.push(p);
    return h.start;
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  apiKeys,
  links,
  channelMembers,
  messages,
} from "@synap/database";
import { AiReactionMode } from "@synap/database/schema";
import { routeRoomMessage, answerRoomChoice } from "../route-room.js";

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
const PEER = randomUUID();
const RESEARCHER = randomUUID();
const WRITER = randomUUID();
const SOLO = randomUUID();
const DUO = randomUUID();
const SHARED = randomUUID();

async function member(
  channelId: string,
  memberId: string,
  kind: string,
  at: string
) {
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, $4, $5)`,
    [randomUUID(), channelId, memberId, kind, at]
  );
}

beforeAll(async () => {
  for (const t of [users, apiKeys, links, channelMembers, messages]) {
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x', 'human'), ($2, 'p@x', 'human')`,
    [OWNER, PEER]
  );
  for (const [id, type, name] of [
    [RESEARCHER, "researcher", "Researcher"],
    [WRITER, "writer", "Writer"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, $2, $3, 'agent', $4, $5)`,
      [id, `${id}@x`, name, type, OWNER]
    );
  }
  // SOLO: the owner + one house agent. DUO: the owner + two house agents.
  // SHARED: the owner, another person, one house agent.
  await member(SOLO, OWNER, "human", "2026-10-01T00:00:00Z");
  await member(SOLO, RESEARCHER, "ai_agent", "2026-10-01T00:00:01Z");
  await member(DUO, OWNER, "human", "2026-10-01T00:00:00Z");
  await member(DUO, RESEARCHER, "ai_agent", "2026-10-01T00:00:01Z");
  await member(DUO, WRITER, "ai_agent", "2026-10-01T00:00:02Z");
  await member(SHARED, OWNER, "human", "2026-10-01T00:00:00Z");
  await member(SHARED, PEER, "human", "2026-10-01T00:00:01Z");
  await member(SHARED, RESEARCHER, "ai_agent", "2026-10-01T00:00:02Z");
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

beforeEach(() => {
  h.turns.length = 0;
  h.start = true;
});

const confident = (channelId: string, mentionHandles: string[] = []) =>
  routeRoomMessage({
    channelId,
    senderId: OWNER,
    reactionMode: AiReactionMode.WHEN_CONFIDENT,
    mentionHandles,
  });

describe("routeRoomMessage", () => {
  it("one house agent and the sender alone: it answers", async () => {
    expect(await confident(SOLO)).toMatchObject({
      kind: "answer",
      teammateId: RESEARCHER,
      source: "direct",
    });
  });

  it("another person in the room: nobody named ⇒ silence", async () => {
    expect(await confident(SHARED)).toMatchObject({ kind: "silent" });
  });

  it("…but a mention still summons the agent", async () => {
    expect(await confident(SHARED, ["researcher"])).toMatchObject({
      kind: "answer",
      teammateId: RESEARCHER,
      source: "mention",
    });
  });

  it("two house agents, nobody named ⇒ the person chooses", async () => {
    const r = await confident(DUO);
    expect(r.kind).toBe("choose");
    expect(
      r.kind === "choose" && r.candidates.map((c) => c.agentUserId)
    ).toEqual([RESEARCHER, WRITER]);
  });

  it("only_mentioned: silence, no choice", async () => {
    expect(
      await routeRoomMessage({
        channelId: DUO,
        senderId: OWNER,
        reactionMode: AiReactionMode.ONLY_MENTIONED,
        mentionHandles: [],
      })
    ).toMatchObject({ kind: "silent" });
  });
});

describe("answerRoomChoice — one answer per choice", () => {
  async function seedChoice(): Promise<{ trigger: string; choice: string }> {
    const trigger = randomUUID();
    const choice = randomUUID();
    await q(
      `insert into messages (id, channel_id, user_id, role, content, metadata) values ($1, $2, $3, 'user', 'what do you think?', '{}'::jsonb)`,
      [trigger, DUO, OWNER]
    );
    await q(
      `insert into messages (id, channel_id, user_id, role, content, metadata) values ($1, $2, $3, 'system', 'Who should answer?', $4::jsonb)`,
      [
        choice,
        DUO,
        OWNER,
        JSON.stringify({
          routeChoice: {
            triggerMessageId: trigger,
            candidates: [
              { agentUserId: RESEARCHER, name: "Researcher" },
              { agentUserId: WRITER, name: "Writer" },
            ],
          },
        }),
      ]
    );
    return { trigger, choice };
  }
  const answer = (choice: string, agentUserId: string) =>
    answerRoomChoice({
      channelId: DUO,
      callerId: OWNER,
      choiceMessageId: choice,
      agentUserId,
    });

  it("the first tap starts the turn on the original message; a second is refused", async () => {
    const { trigger, choice } = await seedChoice();
    expect(await answer(choice, WRITER)).toEqual({
      status: "started",
      agentUserId: WRITER,
    });
    expect(h.turns).toEqual([
      expect.objectContaining({ userMessageId: trigger, agentType: "writer" }),
    ]);
    expect(await answer(choice, RESEARCHER)).toEqual({
      status: "refused",
      reason: "already_answered",
    });
    expect(h.turns).toHaveLength(1);
  });

  it("two simultaneous taps start ONE turn — the claim is atomic", async () => {
    const { choice } = await seedChoice();
    const results = await Promise.all([
      answer(choice, WRITER),
      answer(choice, RESEARCHER),
    ]);
    expect(results.filter((r) => r.status === "started")).toHaveLength(1);
    expect(results.filter((r) => r.status === "refused")).toEqual([
      { status: "refused", reason: "already_answered" },
    ]);
    expect(h.turns).toHaveLength(1);
  });

  it("a turn that does not start releases the claim — the person can pick again", async () => {
    const { choice } = await seedChoice();
    h.start = false;
    expect(await answer(choice, WRITER)).toEqual({
      status: "refused",
      reason: "not_started",
    });
    h.start = true;
    expect(await answer(choice, WRITER)).toEqual({
      status: "started",
      agentUserId: WRITER,
    });
  });

  it("an agent that is not a candidate is refused", async () => {
    const { choice } = await seedChoice();
    expect(await answer(choice, randomUUID())).toEqual({
      status: "refused",
      reason: "not_a_candidate",
    });
    expect(h.turns).toHaveLength(0);
  });
});
