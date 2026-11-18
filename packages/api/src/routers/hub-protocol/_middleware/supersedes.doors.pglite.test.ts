/**
 * `supersedes` on every REAL Hub REST filing door, with a REAL failed proposal
 * (wave-2 code review 3; plan 8032a127 D3).
 *
 * Driven through the REAL hub app (`hubProtocolRestApp`: every middleware and
 * route file, the `supersedes` wrapper where it is mounted) and the REAL
 * filing cores behind each route (`checkPermissionOrPropose`,
 * `executeCapability` and its gate, `submitCaptureGraph`), down to the REAL
 * insert door, on PGlite with every @synap/database table. Stubbed: the
 * delegation check (the auth door's mock ends as it does for the Intelligence
 * Service's turn, the caller `supersedes` exists for: the operator acts, the
 * turn's agent performs, under the delegation's full-access grant, with
 * `runWithActingAgent` + `runWithGrant`), the event log, the job queue,
 * realtime, audit, the split-brain guard. The agent is ask-first (its writes
 * are filed for review), and an active key links it to the operator (the
 * routes' `resolveActorId`).
 *
 * What each door files is LEARNED, not assumed: a first call without
 * `supersedes` must file exactly one proposal (non-vacuity: a door that
 * applied at once, or filed nothing, fails here, not later). That row is
 * turned into the failure another agent left for the same person; then:
 *  - the SAME request again, naming it → it ends `withdrawn`, pointing at the
 *    new row, and the reply names it (rules out "the door never reaches the
 *    insert", the orphan of finding d6ac7003);
 *  - a call naming a failure of ANOTHER kind (a LinkedIn send) → 409
 *    SUPERSEDES_REFUSED, nothing filed, the failure kept (rules out "filed
 *    beside a failure that never ends", and "a 500").
 * What this does NOT cover: an MCP door (its own test), a door outside
 * SUPERSEDES_DOORS, production Postgres's transaction isolation (PGlite runs
 * one connection, so a transaction body runs on the same handle).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    grant: null as unknown,
    ids: {
      owner: globalThis.crypto.randomUUID(),
      agent: globalThis.crypto.randomUUID(),
    },
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: run a transaction body on the same handle.
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
  const noop = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? undefined
            : async () => ({ id: globalThis.crypto.randomUUID() }),
      }
    );
  const db = await h.init();
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: noop(),
    EventRepository: class {
      constructor() {
        return noop();
      }
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => globalThis.crypto.randomUUID() }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
// The hub auth door as it ends for an Intelligence Service turn
// (`authenticateIsDelegation`): the operator is the acting user, the turn's
// agent performs the action, under the delegation's full-access grant.
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hubAuthMiddleware: async (c: Context, next: Next) => {
    const { runWithActingAgent, runWithGrant } =
      await import("@synap/database");
    c.set("userId" as never, h.ids.owner as never);
    c.set("linkedUserId" as never, h.ids.owner as never);
    c.set("agentUserId" as never, h.ids.agent as never);
    c.set("keyType" as never, "is_internal" as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    await runWithActingAgent(h.ids.agent, () =>
      runWithGrant(h.grant as never, () => next())
    );
  },
}));

import { Hono } from "hono";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { grantOfScope } from "@synap/database";
import { applyAgentPosture } from "@synap/database/agent-governance";
// Registers the grant read provider the database floors call (as the API does
// at load): otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { hubProtocolRestApp } from "../../hub-protocol-rest.js";
import { SUPERSEDES_DOORS } from "../../../services/proposals/supersedes-door.js";
import { SUPERSEDES_REFUSED } from "./supersedes.js";

const OWNER = h.ids.owner;
const AGENT = h.ids.agent;
/** The agent that filed the failure: not the one asked to replace it. */
const AUTHOR = randomUUID();
const NOTE_KIND = randomUUID();
const ENTITY = randomUUID();
const SKILL = randomUUID();

const server = new Hono();
server.route("/api/hub", hubProtocolRestApp);

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

type Door = (typeof SUPERSEDES_DOORS)[number];

/** A body each door files ONE proposal for, fresh per call. */
function bodyFor(door: Door): Record<string, unknown> {
  const tag = randomUUID().slice(0, 8);
  switch (door.route) {
    case "/capabilities/execute":
      return { skillId: SKILL, parameters: { text: `Hello ${tag}` } };
    case "/entities":
      return { profileSlug: "note", title: `Supersedes note ${tag}` };
    case "/entities/:entityId":
      return { title: `Renamed ${tag}` };
    case "/capture/graph":
      return {
        entities: [
          { ref: "n1", profileSlug: "note", title: `Captured note ${tag}` },
        ],
      };
  }
  throw new Error(`no body for ${door.route}`);
}

async function call(door: Door, extra: Record<string, unknown> = {}) {
  const path = door.route.replace(":entityId", ENTITY);
  const res = await server.request(`/api/hub${path}`, {
    method: door.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...bodyFor(door), ...extra }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

interface Row {
  id: string;
  status: string;
  proposal_type: string;
  target_type: string;
  target_id: string;
  subject_user_id: string | null;
  data: Record<string, unknown> | null;
}

const proposalIds = async () =>
  new Set(
    (await q<{ id: string }>(`select id from proposals`)).rows.map((r) => r.id)
  );
const rowOf = async (id: string) =>
  (
    await q<Row>(
      `select id, status, proposal_type, target_type, target_id, subject_user_id, data
         from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;

/** The proposals a call filed (the ids that were not there before). */
async function filedBy<T>(run: () => Promise<T>) {
  const before = await proposalIds();
  const out = await run();
  const after = await proposalIds();
  const filed = [...after].filter((id) => !before.has(id));
  return { out, filed };
}

/** Turn a row this door filed into another agent's failure for OWNER. */
async function failIt(id: string) {
  await q(
    `update proposals set status = 'approval_failed', agent_user_id = $2,
       created_by = $2, subject_user_id = $3,
       data = coalesce(data, '{}'::jsonb) || '{"failure":{"errorClass":"missing_field"}}'::jsonb
     where id = $1`,
    [id, AUTHOR, OWNER]
  );
}

/** A LinkedIn send that failed for OWNER: another kind of request. */
async function failedSend(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, subject_user_id)
     values ($1, 'approval_failed', 'messaging.external.send', 'messaging', $2,
       '{"body":"Hi","failure":{"errorClass":"missing_field"}}'::jsonb, $3, $3, $4)`,
    [id, randomUUID(), AUTHOR, OWNER]
  );
  return id;
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  // What the auth door grants an IS delegation (`IS_DELEGATION_GRANT`).
  h.grant = grantOfScope({ permissions: ["*"] });
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner-sd@x.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values
       ($1, 'agent-sd@x.test', 'agent', $3), ($2, 'author-sd@x.test', 'agent', $3)`,
    [AGENT, AUTHOR, OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1, $2, 'owner')`,
    [randomUUID(), OWNER]
  );
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1, $2, $3, true)`,
    [randomUUID(), AGENT, OWNER]
  );
  await applyAgentPosture({
    db: h.db as never,
    agentUserId: AGENT,
    posture: "ask-first",
    createdBy: OWNER,
  });
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1, 'note', 'Note', 'kind', 'system', 'pod', true, '{}'::jsonb, null)`,
    [NOTE_KIND]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title)
     values ($1, $2, null, $3, 'note', 'An existing note')`,
    [ENTITY, OWNER, NOTE_KIND]
  );
  // An enabled verb of OWNER's that writes (not a declared read): an agent's
  // run of it is filed for review.
  await q(
    `insert into skills (id, name, description, kind, status, approved, user_id, workspace_id, metadata)
     values ($1, 'supersedes_demo_post', 'Posts a text', 'code', 'active', true, $2, null, '{}'::jsonb)`,
    [SKILL, OWNER]
  );
}, 120_000);

describe("supersedes on every real Hub REST filing door", () => {
  it("covers the four doors (non-vacuity)", () => {
    expect(SUPERSEDES_DOORS.map((d) => `${d.method} ${d.route}`)).toEqual([
      "POST /capabilities/execute",
      "POST /entities",
      "PATCH /entities/:entityId",
      "POST /capture/graph",
    ]);
  });

  for (const door of SUPERSEDES_DOORS) {
    describe(`${door.method} ${door.route}`, () => {
      it("the same request again ends the failed one, pointing at the new row", async () => {
        // Learn what this door files: exactly one proposal, for OWNER.
        const first = await filedBy(() => call(door));
        expect(first.out.status, JSON.stringify(first.out.body)).toBeLessThan(
          300
        );
        expect(first.filed, JSON.stringify(first.out.body)).toHaveLength(1);
        const learned = await rowOf(first.filed[0]!);
        expect(learned.status).toBe("pending");
        // Not the send the other case names: that case must be another kind.
        expect(learned.proposal_type).not.toBe("messaging.external.send");
        await failIt(learned.id);

        const again = await filedBy(() =>
          call(door, { supersedes: learned.id })
        );
        expect(again.out.status, JSON.stringify(again.out.body)).toBeLessThan(
          300
        );
        expect(again.filed).toHaveLength(1);
        const replacement = await rowOf(again.filed[0]!);
        expect(replacement.proposal_type).toBe(learned.proposal_type);
        expect(replacement.target_type).toBe(learned.target_type);
        expect(replacement.status).toBe("pending");

        const old = await rowOf(learned.id);
        expect(old.status).toBe("withdrawn");
        expect(old.data?.supersededBy).toBe(replacement.id);
        expect(again.out.body.supersedes).toEqual({
          proposalId: learned.id,
          replacedBy: replacement.id,
        });
      });

      it("a failure of another kind is refused: 409, nothing filed, the failure kept", async () => {
        const send = await failedSend();
        const { out, filed } = await filedBy(() =>
          call(door, { supersedes: send })
        );
        expect(out.status, JSON.stringify(out.body)).toBe(409);
        expect(out.body.code).toBe(SUPERSEDES_REFUSED);
        expect(String(out.body.error)).toMatch(
          /another kind of request \(messaging\.external\.send on messaging\).*Nothing was filed\./
        );
        expect(filed).toEqual([]);
        expect((await rowOf(send)).status).toBe("approval_failed");
      });
    });
  }
});
