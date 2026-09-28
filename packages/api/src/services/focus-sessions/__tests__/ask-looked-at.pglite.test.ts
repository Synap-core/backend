/**
 * "WHAT I LOOKED AT" on an ask — end to end through the REAL doors on PGlite.
 *
 * WRITE: the MCP `synap_update_session` handler (the door agents raise an ask
 * through) → `expectedOutputWireSchema` (the ONE ask schema: cap of 8, the
 * agent's `title` stripped) → `updateFocusSession` → the ref floor
 * (`findUnreachableOutputRefs`, now covering `ask.lookedAt`) → the row.
 * READ: the tRPC `focusSessions.owed` door → `listOwedSlots` → the names,
 * resolved through the READER's access floor (`looked-at.ts`, `scopedDb`).
 *
 * Stubbed, as in the sibling suites: `checkPermissionOrPropose` (grants — the
 * ladder has its own suites), channel mint, realtime emit, block guidance,
 * the needs-you notification.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

const { permSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(
    async (_args: Record<string, unknown>) => ({}) as Record<string, unknown>
  ),
}));
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: permSpy,
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));

vi.mock("../notify-needs-you.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySessionNeedsYou: vi.fn(async () => undefined),
}));
vi.mock("../../../middleware/read-only-guard.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../../../middleware/audit-log.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { sessionHandlers } from "../../../routers/mcp/handlers/session.js";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import type { Context } from "../../../types/context.js";

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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";
const OTHER = "user-2";
const AGENT = randomUUID();

async function seedSession(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, 'Vendor pick', 'Pick a vendor', 'active', 'human',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now())`,
    [id, USER]
  );
  return id;
}

async function seedEntity(owner: string, title: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, title, created_at, updated_at)
     values ($1, $2, 'note', $3, now(), now())`,
    [id, owner, title]
  );
  return id;
}

async function seedDocument(owner: string, title: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into documents (id, user_id, title, type, storage_key, mime_type, created_at, updated_at)
     values ($1, $2, $3, 'markdown', $4, 'text/markdown', now(), now())`,
    [id, owner, title, `k/${id}`]
  );
  return id;
}

/** The agent raises an ask through the MCP door. */
async function ask(sessionId: string, lookedAt: unknown[]) {
  const res = await sessionHandlers.synap_update_session!({
    toolName: "synap_update_session",
    userId: USER,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.write"],
    args: {
      sessionId,
      expectedOutputs: [
        {
          kind: "decision",
          label: "Pick vendor",
          owner: "human",
          blockedReason: "decision",
          why: "Which vendor do we sign?",
          ask: {
            mode: "choose",
            options: [{ label: "Acme", recommended: true }, { label: "Globex" }],
            lookedAt,
          },
        },
      ],
    },
  } as never);
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

const storedAsk = async (sessionId: string) =>
  (
    await q<{ expected_outputs: Array<{ ask?: { lookedAt?: unknown[] } }> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.expected_outputs[0]?.ask;

const owedRead = async (userId: string) =>
  focusSessionsRouter
    .createCaller({ authenticated: true, userId } as unknown as Context)
    .owed({ limit: 50 });

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await h.client!.exec(`
    insert into users (id, email, user_type) values
      ('${USER}', 'u1@x.test', 'human'), ('${OTHER}', 'u2@x.test', 'human');
    insert into users (id, email, user_type, created_by_user_id)
      values ('${AGENT}', 'a@x.test', 'agent', '${USER}');
  `);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from entities; delete from documents;"
  );
  permSpy.mockClear();
  permSpy.mockImplementation(async () => ({}));
});

describe('an ask carries "what I looked at"', () => {
  it("the value arrives on the owed read, titled by the pod, never by the agent", async () => {
    const sessionId = await seedSession();
    const acme = await seedEntity(USER, "Acme Corp");
    const pricing = await seedDocument(USER, "Pricing notes");

    const res = await ask(sessionId, [
      { kind: "entity", id: acme, title: "SPOOFED BY THE AGENT" },
      { kind: "document", id: pricing },
    ]);
    expect(res.error, JSON.stringify(res)).toBeUndefined();

    // Stored as {kind, id}: the agent's title never reached the row.
    expect((await storedAsk(sessionId))?.lookedAt).toEqual([
      { kind: "entity", id: acme },
      { kind: "document", id: pricing },
    ]);

    const owed = (await owedRead(USER)).filter((s) => s.sessionId === sessionId);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.ask?.lookedAt).toEqual([
      { kind: "entity", id: acme, title: "Acme Corp" },
      { kind: "document", id: pricing, title: "Pricing notes" },
    ]);

    // A rename shows up: the name is read, not stored.
    await q(`update entities set title = 'Acme Corporation' where id = $1`, [acme]);
    const renamed = (await owedRead(USER)).find((s) => s.sessionId === sessionId);
    expect(renamed!.ask?.lookedAt?.[0]?.title).toBe("Acme Corporation");
  });

  it("a ref the reader can no longer see is dropped on the read", async () => {
    const sessionId = await seedSession();
    const acme = await seedEntity(USER, "Acme Corp");
    const pricing = await seedDocument(USER, "Pricing notes");
    await ask(sessionId, [
      { kind: "entity", id: acme },
      { kind: "document", id: pricing },
    ]);
    // The entity leaves this person's reach after the ask was raised.
    await q(`update entities set user_id = $1 where id = $2`, [OTHER, acme]);
    const owed = (await owedRead(USER)).find((s) => s.sessionId === sessionId);
    expect(owed!.ask?.lookedAt).toEqual([
      { kind: "document", id: pricing, title: "Pricing notes" },
    ]);
  });

  it("refuses a cited object the agent's principal cannot see, and stores nothing", async () => {
    const sessionId = await seedSession();
    const foreign = await seedEntity(OTHER, "Someone else's deal");
    const res = await ask(sessionId, [{ kind: "entity", id: foreign }]);
    expect(JSON.stringify(res)).toMatch(/cannot see/);
    expect(await storedAsk(sessionId)).toBeUndefined();
  });

  it("refuses a ninth ref at the parse (capped at 8, never clipped)", async () => {
    const sessionId = await seedSession();
    const ids = await Promise.all(
      Array.from({ length: 9 }, (_, i) => seedEntity(USER, `E${i}`))
    );
    const res = await ask(
      sessionId,
      ids.map((id) => ({ kind: "entity", id }))
    );
    expect(String(res.error ?? "")).toMatch(/lookedAt/);
    expect(await storedAsk(sessionId)).toBeUndefined();
    const ok = await ask(
      sessionId,
      ids.slice(0, 8).map((id) => ({ kind: "entity", id }))
    );
    expect(ok.error).toBeUndefined();
    expect((await storedAsk(sessionId))?.lookedAt).toHaveLength(8);
  });
});
