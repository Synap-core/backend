/**
 * WHO SPOKE on an a2ai reply — on a real Postgres (PGlite), through the real
 * worker and the real `persistAssistantReply`, read back from the STORED row
 * by the one speaker rule (`messageSpeakerIds`, `@synap-core/types/activity`).
 *
 * The defect this pins: the worker stored the reply with `userId` = the owner
 * the agent acts for and no `routedTeammateId` / `metadata.agentId`, so the
 * speaker rule found no id and the reply read unnamed ("AI") on both surfaces
 * while every other reply path named its agent.
 *
 * Stubbed: the IS transport (the turn's text) and the notification door. Not
 * covered, measured: the directory lookup that turns the id into a name — that
 * is the surfaces' job and the rule's own tests.
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
    requestHeadlessChatText: vi.fn(),
  };
  return state;
});

// `persistAssistantReply` writes through the database package's OWN client,
// not the barrel's `db` — both are the PGlite here, so the row is real.
vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    // agent_configs read: no row = the IS reads its own defaults.
    agentOverridesForTurn: async () => undefined,
  };
});
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requestHeadlessChatText: (...args: unknown[]) =>
      h.requestHeadlessChatText(...args),
  };
});
vi.mock("../utils/notification-creator.js", () => ({
  createNotificationViaService: async () => "notif-1",
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { messageSpeakerIds } from "@synap-core/types/activity";
import { handleA2AIResponseTrigger } from "./a2ai-response-trigger.js";

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
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this worker writes.
      }
    }
  }
  // The turn claim is `ON CONFLICT (user_id, request_id) DO NOTHING`.
  await h.client!.exec(
    `create unique index if not exists chat_turns_user_request on chat_turns (user_id, request_id);`
  );
}, 120_000);

async function runTurn(agentUserId: string | undefined) {
  const channelId = randomUUID();
  const userMessageId = randomUUID();
  h.requestHeadlessChatText.mockResolvedValue({
    text: "Here is the summary.",
    error: null,
    steps: [],
    partialFailure: null,
  });
  await handleA2AIResponseTrigger({
    id: "job-1",
    name: "a2ai-response-trigger",
    retryCount: 0,
    data: {
      channelId,
      userMessageId,
      content: "summarise this",
      userId: "owner-1",
      workspaceId: null,
      agentType: "meta",
      sourceAgentUserId: "owner-1",
      serviceUrl: "http://is.test",
      serviceApiKey: "k",
      serviceId: "svc-1",
      ...(agentUserId ? { agentUserId } : {}),
    },
  } as never);
  const { rows } = await h.client!.query<{
    role: string;
    author_type: string;
    user_id: string;
    routed_teammate_id: string | null;
    routed_source: string | null;
    metadata: unknown;
  }>(
    `select role, author_type, user_id, routed_teammate_id, routed_source, metadata
       from messages where channel_id = $1`,
    [channelId]
  );
  return rows;
}

describe("a2ai reply — the stored row names its agent", () => {
  it("records the agent user the turn ran as, so the speaker rule names it", async () => {
    const rows = await runTurn("agent-user-1");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The owner stays the owner; the agent is the routed teammate.
    expect(row.user_id).toBe("owner-1");
    expect(row.routed_teammate_id).toBe("agent-user-1");
    expect(row.routed_source).toBe("direct");
    expect(
      messageSpeakerIds({
        role: row.role,
        authorType: row.author_type,
        userId: row.user_id,
        routedTeammateId: row.routed_teammate_id,
        metadata: row.metadata,
      })
    ).toEqual(["agent-user-1"]);
  });

  it("records nothing when no agent user was resolved — unnamed, never the owner", async () => {
    const rows = await runTurn(undefined);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.routed_teammate_id).toBeNull();
    expect(
      messageSpeakerIds({
        role: row.role,
        authorType: row.author_type,
        userId: row.user_id,
        routedTeammateId: row.routed_teammate_id,
        metadata: row.metadata,
      })
    ).toEqual([]);
  });
});
