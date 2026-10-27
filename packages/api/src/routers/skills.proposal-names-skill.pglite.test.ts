/**
 * A skill proposal NAMES the skill (needs-truth §2 (f), plan v5 PR C).
 *
 * The defect: `skills.update` gated `{ id, ...patch }`. A patch carries no name
 * unless it renames, so the summary composer found nothing to quote and five
 * pending agent edits on the founder's pod read "Update Tool": which skill,
 * nobody could tell. Delete had the same hole (`{ id }`). And a rename's patch
 * carries the NEW name, which the inline read would have quoted: a name the
 * reviewer does not know yet.
 *
 * `resolveProposalTargetName` reads the skill's CURRENT name by id. The noun
 * stays the vocabulary's ("Tool", founder D2, `resolveObjectNoun`).
 *
 * Driven end to end: the REAL `skills` router as an agent → the REAL gate
 * (proposed by the person's own rule) → `createProposal` → the stored proposal
 * ROW read back from PGlite. The assertion is the stored summary.
 *
 * Stubbed, and why (as `gate-envelope-approve.pglite.test.ts`):
 *  - the receipt-session mint and the agent's declared focus → null. The gate
 *    calls them on the module `db` while its proposal transaction is open, and
 *    PGlite has ONE connection, so they would wait forever.
 *  - audit log, side effects, realtime, links, the session channel, the
 *    pod-role check: not this seam.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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

// The database package's own modules read `db` from client-pg, not the barrel.
vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    EventRepository: class {
      async append() {
        return { id: randomUUID() };
      }
      async emitCompleted() {}
    },
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
    resolveOrCreateAgentProposalSession: async () => null,
  };
});
vi.mock("../services/agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => ({ id: randomUUID() })),
}));
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../services/links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLinks: async () => [],
  createLink: async () => ({}),
}));
vi.mock(
  "../services/focus-sessions/ensure-session-channel.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithActingAgent } from "@synap/database";
import { skillsRouter } from "./skills.js";

const USER = randomUUID();
const AGENT = randomUUID();
const SKILL_ID = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** A door call as an agent key makes it: the acting agent is ambient. */
const asAgent = <T>(fn: () => Promise<T>) => runWithActingAgent(AGENT, fn);

const skills = () =>
  skillsRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: USER,
    user: null,
    session: null,
    req: undefined,
    workspaceId: null,
    agentUserId: null,
  } as never);

/** The summary `createProposal` stored on the proposal row. */
async function storedSummary(res: unknown): Promise<string | undefined> {
  const r = res as { status?: string; proposalId?: string };
  if (r.status !== "proposed" || !r.proposalId)
    throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  const { rows } = await q<{ summary: string | null }>(
    `select data->>'summary' as summary from proposals where id = $1`,
    [r.proposalId]
  );
  return rows[0]?.summary ?? undefined;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type, created_by_user_id) values
      ($1, 'u@x.test', 'Ada', 'human', null),
      ($2, 'a@x.test', 'Scout', 'agent', $1)`,
    [USER, AGENT]
  );
  await q(
    `insert into skills (id, user_id, slug, name, body, kind, scope, approved)
     values ($1, $2, 'house-style', 'House style', '# approved body', 'instruction', 'pod', true)`,
    [SKILL_ID, USER]
  );
  // The person's own setting: "ask me before an agent edits or deletes a
  // skill", so every call below is PROPOSED whatever the pod default.
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1, 'any', 'pod', 'action', 'skill.update', 'propose', $3),
            ($2, 'any', 'pod', 'action', 'skill.delete', 'propose', $3)`,
    [randomUUID(), randomUUID(), USER]
  );
});

describe("skill proposals name the skill", () => {
  it("an agent's body edit: the stored summary quotes the skill's name", async () => {
    const res = await asAgent(() =>
      skills().update({ id: SKILL_ID, body: "# rewritten by an agent" })
    );
    expect(await storedSummary(res)).toBe('Update Tool "House style"');
  });

  it("a rename is named by the name the reviewer knows, not the new one", async () => {
    const res = await asAgent(() =>
      skills().update({ id: SKILL_ID, name: "House voice" })
    );
    expect(await storedSummary(res)).toBe('Update Tool "House style"');
  });

  it("a delete names the skill too", async () => {
    const res = await asAgent(() => skills().delete({ id: SKILL_ID }));
    expect(await storedSummary(res)).toBe('Delete Tool "House style"');
  });
});
