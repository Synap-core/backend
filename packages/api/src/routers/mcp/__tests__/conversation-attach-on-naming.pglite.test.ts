/**
 * ATTACH ON NAMING (founder's answer 6, 21 Nov 2026; finding 3edcbe5c), on
 * PGlite: a conversation with NO session of its own that names an existing
 * session as its own is attached to it.
 *
 * Live: the wave session was bound to the lead's first conversation. The lead
 * went on in a fresh conversation, started a lane (a planned child of the
 * wave session, whose binding named the OLD conversation, so the lane was
 * stamped with the NEW one), and from then on every unaddressed write of the
 * lead landed in that lane.
 *
 * Real: the MCP attribution resolver every write goes through
 * (`resolveSessionHandle` → `resolveWorkSession` → `findClientSession`), the
 * write gate's own rung (`findClientSession` with `refuseSeveralStarted`, as
 * `resolveOrCreateAgentProposalSession` calls it) and the lane-start stamp
 * (`newSessionClientKey`), all over the same PGlite rows.
 *
 * Each control rules out a broader rule: "any naming attaches" (acted-on
 * tools), "re-key whatever is named" (another key's session, the person's
 * session, a receipt, a closed one), "attach even with a session of its own"
 * (a conversation that has one), and "any client attaches" (key scope and a
 * per-call run).
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

// `findClientSession` reads the database package's OWN client; the API's
// reads go through the `@synap/database` export. Both are the one PGlite.
vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, proposals } from "@synap/database/schema";
import { findClientSession, runWithClientKey } from "@synap/database";

const { resolveSessionHandle } = await import("../handlers/shared.js");
const { newSessionClientKey, SESSION_ACTED_ON_TOOLS } =
  await import("../../../services/focus-sessions/session-client-binding.js");
const { DOOR_TOOL_NAMES } = await import("../door-tool-names.generated.js");

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = t.endsWith("[]") && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";
const AGENT = "agent-1";
const KEY = "0f4b1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4";
const OTHER_KEY = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
/** The lead's first conversation (where it started the wave session). */
const OLD = `key:${KEY}|conv:claude-code:f47808d7`;
/** The conversation the lead goes on in. */
const NEW = `key:${KEY}|conv:claude-code:f21f6087`;

async function seed(opts: {
  clientKey?: string | null;
  status?: string;
  autoOpened?: boolean;
  title?: string;
}): Promise<string> {
  const id = randomUUID();
  const metadata: Record<string, unknown> = {};
  if (opts.clientKey) metadata.clientKey = opts.clientKey;
  if (opts.autoOpened) metadata.autoOpened = true;
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'work', $3, $4, '[]'::jsonb, $5::jsonb, now(), now(), now())`,
    [
      id,
      USER,
      opts.title ?? null,
      opts.status ?? "active",
      JSON.stringify(metadata),
    ]
  );
  return id;
}

const boundKey = async (id: string) =>
  (
    await q<{ k: string | null }>(
      `select metadata ->> 'clientKey' as k from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.k;

/** One MCP call's attribution, as the adapter makes it. */
const resolveAs = (
  clientKey: string | null,
  tool: string,
  args: Record<string, unknown>
) => {
  const run = () => resolveSessionHandle(tool, args, USER, AGENT);
  return clientKey ? runWithClientKey(clientKey, run) : run();
};

beforeAll(async () => {
  await h.init();
  await h.client!.exec(
    [focusSessions, proposals]
      .map((t) => ddlFor(t as unknown as PgTable))
      .join("\n")
  );
}, 120_000);
beforeEach(async () => {
  await q(`delete from focus_sessions`);
});

describe("a conversation with no session of its own is attached to the session it names", () => {
  it("the lead's new conversation names its wave session: attached; its next unaddressed write and its lane start follow", async () => {
    const wave = await seed({ clientKey: OLD, title: "Wave" });
    // A receipt of the new conversation is not a session of its own.
    await seed({ clientKey: NEW, autoOpened: true });

    const named = await resolveAs(NEW, "synap_capture", { sessionId: wave });
    expect(named?.session?.sessionId).toBe(wave);
    expect(named?.attribution).toMatchObject({
      session: "explicit",
      attached: true,
    });
    expect(await boundKey(wave)).toBe(NEW);

    // The next write that names nothing: the MCP door and the gate's rung.
    const ambient = await resolveAs(NEW, "synap_capture", {});
    expect(ambient?.session?.sessionId).toBe(wave);
    expect(ambient?.attribution).toMatchObject({
      session: "derived",
      via: "client",
    });
    expect(
      (await findClientSession(USER, NEW, { refuseSeveralStarted: true }))?.id
    ).toBe(wave);

    // The lane it starts under the wave session is NOT bound to it.
    expect(
      await runWithClientKey(NEW, () =>
        newSessionClientKey({
          clientKey: NEW,
          agentUserId: AGENT,
          userId: USER,
          parentSessionId: wave,
        })
      )
    ).toBeNull();
  });

  it("start_session with sessionId attaches", async () => {
    const wave = await seed({ clientKey: OLD });
    const r = await resolveAs(NEW, "synap_start_session", {
      sessionId: wave,
      goal: "work",
    });
    expect(r?.attribution).toMatchObject({ attached: true });
    expect(await boundKey(wave)).toBe(NEW);
  });

  it("a coordination post FROM a session (fromSessionId) attaches to that one, never to the target", async () => {
    const wave = await seed({ clientKey: OLD });
    const lane = await seed({ clientKey: OLD });
    const r = await resolveAs(NEW, "synap_post_message", {
      toSessionId: lane,
      intent: "fyi",
      fromSessionId: wave,
      content: "go on",
    });
    expect(r?.attribution).toMatchObject({ attached: true });
    expect(await boundKey(wave)).toBe(NEW);
    expect(await boundKey(lane)).toBe(OLD);
  });
});

describe("CONTROLS: what never attaches (the named session is used for that call only)", () => {
  it("a conversation that has its own session keeps it", async () => {
    const own = await seed({ clientKey: NEW, title: "Own" });
    const wave = await seed({ clientKey: OLD });
    const r = await resolveAs(NEW, "synap_capture", { sessionId: wave });
    expect(r?.session?.sessionId).toBe(wave);
    expect(r?.attribution).not.toHaveProperty("attached");
    expect(await boundKey(wave)).toBe(OLD);
    const ambient = await resolveAs(NEW, "synap_capture", {});
    expect(ambient?.session?.sessionId).toBe(own);
  });

  it("every acted-on tool is a real MCP tool (a rename cannot empty the list)", () => {
    expect(SESSION_ACTED_ON_TOOLS.size).toBeGreaterThanOrEqual(7);
    for (const tool of SESSION_ACTED_ON_TOOLS) {
      expect(DOOR_TOOL_NAMES, tool).toHaveProperty(tool);
    }
  });

  it.each([...SESSION_ACTED_ON_TOOLS])(
    "%s names the session it acts on, not the caller's",
    async (tool) => {
      const lane = await seed({ clientKey: OLD });
      const r = await resolveAs(NEW, tool, { sessionId: lane });
      expect(r?.attribution).not.toHaveProperty("attached");
      expect(await boundKey(lane)).toBe(OLD);
    }
  );

  it("another API key's session, the person's own session, a receipt, a closed session", async () => {
    const otherClient = await seed({
      clientKey: `key:${OTHER_KEY}|conv:claude-code:x`,
    });
    const persons = await seed({ clientKey: null });
    const receipt = await seed({ clientKey: OLD, autoOpened: true });
    const closed = await seed({ clientKey: OLD, status: "closed" });
    for (const id of [otherClient, persons, receipt, closed]) {
      const r = await resolveAs(NEW, "synap_capture", { sessionId: id });
      expect(r?.attribution).not.toHaveProperty("attached");
    }
    expect(await boundKey(otherClient)).toBe(
      `key:${OTHER_KEY}|conv:claude-code:x`
    );
    expect(await boundKey(persons)).toBeNull();
    expect(await boundKey(receipt)).toBe(OLD);
    expect(await boundKey(closed)).toBe(OLD);
  });

  it("a client that named no conversation: key scope, a per-call run", async () => {
    const wave = await seed({ clientKey: OLD });
    for (const client of [null, `key:${KEY}|call:${randomUUID()}`]) {
      const r = await resolveAs(client, "synap_capture", { sessionId: wave });
      expect(r?.session?.sessionId).toBe(wave);
      expect(r?.attribution).not.toHaveProperty("attached");
    }
    expect(await boundKey(wave)).toBe(OLD);
  });
});
