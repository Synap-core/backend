/**
 * FOUNDER DECISION D — an agent turn runs AS WHOEVER SUMMONED IT, never as the
 * room owner on someone else's behalf. Real `triggerAutoRespond` on PGlite.
 *
 * The enqueued job's `userId` is what the IS sends as X-Delegated-Operator-Id
 * (the read floor + governance operator of every Hub call), and the IS routing
 * is resolved for the same user — so both are asserted.
 *
 * Covered: owner summons (unchanged), a member's summons (runs as the member),
 * a member's agent (runs as that agent's human), the owner's own agent and an
 * ownerless system agent (stay the owner), owner flows that pass the owner
 * (slot answer, delegated output) stay the owner.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  sent: [] as Array<Record<string, unknown>>,
  routedFor: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../intelligence-routing.js", () => ({
  resolveIntelligenceService: async (p: { userId: string }) => {
    holder.routedFor.push(p.userId);
    return {
      endpoint: "http://is.test",
      serviceApiKey: "k",
      serviceId: "svc",
      agentUserId: `agent-of-${p.userId}`,
    };
  },
}));
vi.mock("@synap/jobs", () => ({
  A2AI_TRIGGER_JOB_OPTIONS: {},
  A2AI_TRIGGER_QUEUE: "queue",
  getBoss: () => ({
    send: async (_q: string, data: Record<string, unknown>) => {
      holder.sent.push(data);
      return "job-1";
    },
  }),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, channels, messages, users } from "@synap/database";
import { triggerAutoRespond } from "../trigger-auto-respond.js";
import { resolveTurnAgentUserId } from "../../services/messaging/turn-principal.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  for (const t of [focusSessions, channels, messages, users]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  holder.db = drizzle(client, {
    schema: { focusSessions, channels, messages, users },
  });
  holder.sent.length = 0;
  holder.routedFor.length = 0;
  await client.exec(`
    insert into users (id, email, user_type, created_by_user_id) values
      ('owner', 'o@x', 'human', null),
      ('member', 'm@x', 'human', null),
      ('owner-agent', 'oa@x', 'agent', 'owner'),
      ('member-agent', 'ma@x', 'agent', 'member'),
      ('system-agent', 'sa@x', 'agent', null);
  `);
});

async function room(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into channels (user_id, workspace_id, channel_type, scope, status, title, ai_reaction_mode)
     values ('owner', null, 'group', 'pod', 'active', 'room', 'only_mentioned') returning id`
  );
  return rows[0]!.id;
}

async function message(channelId: string, author: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into messages (channel_id, role, author_type, message_category, content, user_id, hash, metadata)
     values ($1, 'user', 'human', 'chat', 'hi', $2, gen_random_uuid()::text, '{}'::jsonb) returning id`,
    [channelId, author]
  );
  return rows[0]!.id;
}

async function summon(
  sourceUserId: string | null
): Promise<Record<string, unknown>> {
  const channelId = await room();
  const ok = await triggerAutoRespond({
    channelId,
    userMessageId: await message(channelId, sourceUserId ?? "owner"),
    content: "@ai what do you know about the budget?",
    sourceUserId,
    agentType: "meta",
  });
  expect(ok).toBe(true);
  expect(holder.sent).toHaveLength(1);
  return holder.sent[0]!;
}

describe("triggerAutoRespond — the turn runs as the SUMMONER (decision D)", () => {
  it("a non-owner member's summons runs as the member — never the owner", async () => {
    const job = await summon("member");
    expect(job.userId).toBe("member");
    expect(holder.routedFor).toEqual(["member"]);
    expect(job.agentUserId).toBe("agent-of-member");
    expect(job.sourceAgentUserId).toBe("member");
  });

  it("the owner's summons is unchanged — runs as the owner", async () => {
    const job = await summon("owner");
    expect(job.userId).toBe("owner");
    expect(holder.routedFor).toEqual(["owner"]);
  });

  it("no summoner (an owner flow) runs as the owner", async () => {
    const job = await summon(null);
    expect(job.userId).toBe("owner");
  });

  it("a member's AGENT runs as that agent's human, not the owner", async () => {
    const job = await summon("member-agent");
    expect(job.userId).toBe("member");
  });

  it("the owner's own agent, and an ownerless system agent, stay the owner", async () => {
    expect((await summon("owner-agent")).userId).toBe("owner");
    holder.sent.length = 0;
    expect((await summon("system-agent")).userId).toBe("owner");
  });
});

describe("resolveTurnAgentUserId — the interactive door acts as the principal's ONE personal AI (decision 6b45c6c3)", () => {
  async function personalAgentsOf(owner: string): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `select id from users where created_by_user_id = $1 and is_personal_agent = true`,
      [owner]
    );
    return rows.map((r) => r.id);
  }

  it("the owner summoning a persona teammate acts as the OWNER's personal AI, never the teammate", async () => {
    const acting = await resolveTurnAgentUserId({ principalUserId: "owner" });
    expect(acting).not.toBe("owner-agent");
    expect(await personalAgentsOf("owner")).toEqual([acting]);
  });

  it("a member summoning the owner's @ai acts as the MEMBER's personal AI", async () => {
    const acting = await resolveTurnAgentUserId({ principalUserId: "member" });
    expect(await personalAgentsOf("member")).toEqual([acting]);
    expect(await personalAgentsOf("owner")).toEqual([]);
  });

  it("the personal AI is found, not recreated, and is the same in every room", async () => {
    const first = await resolveTurnAgentUserId({ principalUserId: "owner" });
    expect(await resolveTurnAgentUserId({ principalUserId: "owner" })).toBe(
      first
    );
    expect(await personalAgentsOf("owner")).toEqual([first]);
  });
});
