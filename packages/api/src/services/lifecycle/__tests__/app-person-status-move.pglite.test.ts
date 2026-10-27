/**
 * A person's app sign-in moves a status AS THE PERSON (backend #94: "a Synap
 * pod app acts as the person who consented"; review 2026-10-27 M2).
 *
 * Content Studio's "Brief it", Brand Approve/Reject and "I posted it" are
 * status moves sent with the person's `app_person` key through
 * `PATCH /entities/:id` → the hub forwarder (`hub-protocol/entities.ts`
 * `updateEntity`, which stamps `source: "intelligence"` on every caller) →
 * `entities.update` → `statusMoveActorFor` → `moveStatus`. Driven here through
 * that REAL chain on PGlite, from the hub caller context
 * (`createHubProtocolCallerContext`, AI-branded for every hub-scoped key)
 * inside the request scope the hub auth door enters for that key
 * (`resolveKeyIdentity` → a grant naming the app, NO acting agent):
 *  - Idea → Briefed: applied, the transition's actor is the PERSON (human,
 *    their id, no agent) and it names the app (`appId`);
 *  - into done (Published) and lost (Deprecated): applied, never proposed;
 *  - into a humanOnly option: applied, as the person's own act;
 *  - the unchanged floor: a plain agent key into done is still PROPOSED and
 *    writes nothing; an unattributed hub key (no app) too; an app's own AGENT
 *    key too, its proposal naming nothing as the person.
 *
 * And a PLAIN field the same key PATCHes (the forwarder's `source`,
 * `hubWriteSource`): the person's write, applied on the person's ladder with
 * no proposal and no anonymous-AI receipt; an agent key's same PATCH still
 * runs the agent ladder (a proposal or an auto-approved receipt, both
 * attributed to the agent).
 *
 * NOT COVERED: the Hub HTTP auth door itself (`pod-app-person-token.pglite
 * .test.ts` proves the app_person key resolves to this scope); the event's
 * fan-out (`@synap/events` lifecycle-transition.test.ts proves the outbox
 * transition is spread into the event data, so asserting the outbox row is
 * asserting the event payload).
 *
 * Stubbed, and why (as status-move-grant.pglite.test.ts): post-commit
 * delivery only, and `getAgentFocusProjectId` (PGlite is one connection).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: a transaction reading the module `db`
        // deadlocks. Run the body on the same handle; atomicity is not under
        // test (as own-organise-real-doors.pglite.test.ts).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
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
  await h.init();
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  const EventRepository = actual.EventRepository as new (s: unknown) => {
    append: (e: unknown) => Promise<unknown>;
  };
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../../focus-sessions/ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithCallingKey,
  runWithDerivedSession,
  runWithGrant,
} from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { entitiesRouter as hubEntitiesRouter } from "../../../routers/hub-protocol/entities.js";
import { createHubProtocolCallerContext } from "../../../routers/hub-protocol/utils.js";

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
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf-8"
  );

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();
const KEY = randomUUID();
const WS = randomUUID();
const CONTENT_PROFILE = randomUUID();
const STATUS_DEF = randomUUID();
/** The app's public id, as the person's key grant carries it (`grants.client_id`). */
const APP = "app_contentstudio";

let WORK = "";

/** What the app was granted and the person ticked: work Content OS pieces. */
const PIECES: GrantScope = {
  permissions: ["entity.content.read", "entity.content.update"],
  workspaceIds: [WS],
};

/** The request scope the hub auth door enters for a key. */
const inRequest = <T>(
  grant: { clientId: string | null },
  agent: string | undefined,
  fn: () => Promise<T>
) =>
  runWithGrant(grantOfScope(PIECES, grant.clientId), () =>
    runWithActingAgent(agent, () =>
      runWithCallingKey(KEY, () => runWithDerivedSession(WORK, fn))
    )
  );

/** `PATCH /entities/:id` with `status` + `expectedStatus`, as Content Studio sends it. */
const patchStatus = (
  key: { clientId: string | null; agent?: string },
  entityId: string,
  to: string,
  expectedStatus: string
) => patch(key, entityId, { metadata: { status: to }, expectedStatus });

/** `PATCH /entities/:id` through the hub forwarder, inside the key's request. */
async function patch(
  key: { clientId: string | null; agent?: string },
  entityId: string,
  body: {
    title?: string;
    metadata?: Record<string, unknown>;
    expectedStatus?: string;
  }
) {
  return inRequest(key, key.agent, async () => {
    const ctx = await createHubProtocolCallerContext(
      USER,
      ["hub-protocol.read", "hub-protocol.write"],
      WS,
      null,
      WORK,
      key.agent ?? null
    );
    const res = await hubEntitiesRouter
      .createCaller(ctx as never)
      .updateEntity({
        entityId,
        userId: USER,
        ...body,
      });
    return res as { status?: string };
  });
}

/** The person's own key for the app: grant names the app, no agent acts. */
const PERSON_APP_KEY = { clientId: APP };
/** A plain agent key (no app). */
const AGENT_KEY = { clientId: null, agent: AGENT };
/** The app's own AGENT key: grant names the app AND its agent acts. */
const APP_AGENT_KEY = { clientId: APP, agent: AGENT };
/** A hub key held by no agent and naming no app (a service key). */
const SERVICE_KEY = { clientId: null };

async function seedPiece(status = "idea"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'content', $3, 'A piece', $4, $5, 'open', $6::jsonb, now(), now())`,
    [id, USER, CONTENT_PROFILE, WS, status, JSON.stringify({ status })]
  );
  return id;
}

const titleOf = async (id: string) =>
  (await q<{ title: string }>(`select title from entities where id = $1`, [id]))
    .rows[0]?.title;

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]?.status;

/** The transition the move owes, exactly as its event carries it. */
const transitionsOf = async (id: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'entityId' = $1`,
      [id]
    )
  ).rows.map((r) => r.transition);

const proposalsOn = async (id: string) =>
  (
    await q<{ status: string; agent_user_id: string | null }>(
      `select status, agent_user_id from proposals where target_id::text = $1 or data->>'entityId' = $1`,
      [id]
    )
  ).rows;

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
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
     values ($1, 'Agent', 'a@x', 'agent', 'claude-code', '{}'::jsonb, $2)`,
    [AGENT, USER]
  );
  await q(`insert into workspaces (id, owner_id, name) values ($1, $2, $3)`, [
    WS,
    USER,
    "Content OS",
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'content', 'Content', 'kind', 'system', 'workspace', null, true, '{}'::jsonb, now(), now())`,
    [CONTENT_PROFILE]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "idea", label: "Idea", category: "open" },
          { key: "briefed", label: "Briefed", category: "active" },
          // Not terminal: isolates the humanOnly floor from the done/lost one.
          {
            key: "signed_off",
            label: "Signed off",
            category: "active",
            humanOnly: true,
          },
          { key: "published", label: "Published", category: "done" },
          { key: "deprecated", label: "Deprecated", category: "lost" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [CONTENT_PROFILE, STATUS_DEF]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from proposals; delete from events; delete from focus_sessions; delete from lifecycle_transition_outbox; delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  WORK = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Work', 'Work the pieces', 'active', 'agent',
             '[]'::jsonb, '[]'::jsonb, $3::jsonb, '{}', now(), now(), now())`,
    [WORK, USER, JSON.stringify({ clientKey: `key:${KEY}` })]
  );
});

describe("a person's app sign-in moves a status as the PERSON", () => {
  it("Idea → Briefed: applied, the person's move, naming the app", async () => {
    const piece = await seedPiece("idea");
    const res = await patchStatus(PERSON_APP_KEY, piece, "briefed", "idea");
    expect(res.status, JSON.stringify(res)).not.toBe("proposed");
    expect(await statusOf(piece)).toBe("briefed");
    expect(await transitionsOf(piece)).toEqual([
      expect.objectContaining({
        from: "idea",
        to: "briefed",
        actorKind: "human",
        userId: USER,
        agentUserId: null,
        appId: APP,
      }),
    ]);
    expect(await proposalsOn(piece)).toEqual([]);
  });

  it("into done (Published): applied, not proposed", async () => {
    const piece = await seedPiece("briefed");
    const res = await patchStatus(
      PERSON_APP_KEY,
      piece,
      "published",
      "briefed"
    );
    expect(res.status, JSON.stringify(res)).not.toBe("proposed");
    expect(await statusOf(piece)).toBe("published");
    expect(await transitionsOf(piece)).toEqual([
      expect.objectContaining({
        to: "published",
        category: "done",
        actorKind: "human",
        userId: USER,
        appId: APP,
      }),
    ]);
    expect(await proposalsOn(piece)).toEqual([]);
  });

  it("into lost (Deprecated, Brand Reject): applied, not proposed", async () => {
    const piece = await seedPiece("briefed");
    const res = await patchStatus(
      PERSON_APP_KEY,
      piece,
      "deprecated",
      "briefed"
    );
    expect(res.status, JSON.stringify(res)).not.toBe("proposed");
    expect(await statusOf(piece)).toBe("deprecated");
    expect(await proposalsOn(piece)).toEqual([]);
  });

  it("into a humanOnly option: applied, as the person's own act", async () => {
    const piece = await seedPiece("briefed");
    const res = await patchStatus(
      PERSON_APP_KEY,
      piece,
      "signed_off",
      "briefed"
    );
    expect(res.status, JSON.stringify(res)).not.toBe("proposed");
    expect(await statusOf(piece)).toBe("signed_off");
  });
});

describe("every other key keeps the agent floor", () => {
  it("a plain agent key into done is still proposed, nothing written", async () => {
    const piece = await seedPiece("briefed");
    const res = await patchStatus(AGENT_KEY, piece, "published", "briefed");
    expect(res.status, JSON.stringify(res)).toBe("proposed");
    expect(await statusOf(piece)).toBe("briefed");
    expect(await transitionsOf(piece)).toEqual([]);
    expect(await proposalsOn(piece)).toEqual([
      expect.objectContaining({ status: "pending", agent_user_id: AGENT }),
    ]);
  });

  it("an app's own AGENT key into done is still proposed", async () => {
    const piece = await seedPiece("briefed");
    const res = await patchStatus(APP_AGENT_KEY, piece, "published", "briefed");
    expect(res.status, JSON.stringify(res)).toBe("proposed");
    expect(await statusOf(piece)).toBe("briefed");
  });

  it("a hub key naming no app and holding no agent into done is still proposed", async () => {
    const piece = await seedPiece("briefed");
    const res = await patchStatus(SERVICE_KEY, piece, "published", "briefed");
    expect(res.status, JSON.stringify(res)).toBe("proposed");
    expect(await statusOf(piece)).toBe("briefed");
  });

  it("a plain agent's non-terminal move applies, as the agent (no app named)", async () => {
    const piece = await seedPiece("idea");
    const res = await patchStatus(AGENT_KEY, piece, "briefed", "idea");
    expect(res.status, JSON.stringify(res)).not.toBe("proposed");
    expect(await transitionsOf(piece)).toEqual([
      expect.objectContaining({
        actorKind: "agent",
        agentUserId: AGENT,
        appId: null,
      }),
    ]);
  });
});

describe("a PLAIN field an app sign-in PATCHes is the person's write", () => {
  it("applied on the person's ladder: no proposal, no anonymous-AI receipt", async () => {
    const piece = await seedPiece("idea");
    const res = await patch(PERSON_APP_KEY, piece, { title: "Renamed" });
    expect(res.status, JSON.stringify(res)).not.toBe("proposed");
    expect(await titleOf(piece)).toBe("Renamed");
    // The AI ladders leave a row on every write they decide (a pending
    // proposal, or an auto-approved receipt); the person's ladder leaves none.
    expect(await proposalsOn(piece)).toEqual([]);
  });

  it("an agent key's same PATCH still runs the agent ladder, attributed to it", async () => {
    const piece = await seedPiece("idea");
    await patch(AGENT_KEY, piece, { title: "Renamed by the agent" });
    expect(await proposalsOn(piece)).toEqual([
      expect.objectContaining({ agent_user_id: AGENT }),
    ]);
  });
});
