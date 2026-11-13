/**
 * The place door through the REAL governance gate (`checkPermissionOrPropose`,
 * rung 0 = the key's grant, entered with `runWithGrant` + `runWithActingAgent`
 * as the key-auth doors do), on PGlite with every @synap/database table.
 * `whiteboards.place.test.ts` mocks the gate (a verdict per door); this is the
 * test that would have caught a mock agreeing with a policy that says the
 * opposite.
 *
 * Rows, each ruling out a wrong outcome:
 *  - an AI-preset key (`whiteboard.delete_shapes` is NOT in its grant) that
 *    removes a shape gets a PROPOSAL, never a 403 "denied" (founder: removal
 *    by an agent is a proposal by default) and nothing is written;
 *  - the same call with a create in it writes the create ONCE and proposes the
 *    removal: no half-written call answered as a refusal;
 *  - an update is a proposal, nothing written;
 *  - the key's own create: written at once, marked pending (the ladder's
 *    default for `whiteboard/place`);
 *  - CONTROL: without `proposeBeyondGrant` the removal is DENIED by the grant
 *    (so the proposal above is the door's doing, not the grant's absence).
 *
 * Faked: the board's room (`read-board-scene.js`: the floor and the records),
 * the realtime bridge (`fetch`), delivery side effects. NEEDS-DOGFOOD: a real
 * pod's rules and a running realtime server.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    applies: [] as Array<Record<string, any>>,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
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
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

const OWNER = randomUUID();
const AGENT = randomUUID();
const SPACE = randomUUID();
const VIEW = randomUUID();
const DOC = randomUUID();
const ENTITY = randomUUID();

const RECORDS = {
  "shape:s": {
    id: "shape:s",
    typeName: "shape",
    type: "sticky",
    parentId: "page:page",
    index: "a3",
    x: 10,
    y: 20,
    props: { w: 240, h: 200, content: "Call Bob" },
    meta: {},
  },
  "shape:frame": {
    id: "shape:frame",
    typeName: "shape",
    type: "frame",
    parentId: "page:page",
    index: "a2",
    x: 0,
    y: 0,
    props: { w: 800, h: 600 },
    meta: {},
  },
};

vi.mock("../../../services/whiteboards/read-board-scene.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/whiteboards/read-board-scene.js")
  >()),
  resolveBoardView: async () => ({
    view: {
      id: VIEW,
      type: "whiteboard",
      workspaceId: SPACE,
      documentId: DOC,
      yjsRoomId: null,
    },
    documentId: DOC,
    roomId: `whiteboard-${DOC}`,
    access: "edit",
  }),
  loadBoardRecords: async () => ({
    records: RECORDS,
    source: "live",
    asOf: new Date().toISOString(),
  }),
}));
vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
  // Only the bridge's apply is the write; other bridge calls (a proposal's
  // realtime event) are acknowledged and not counted.
  if (!String(url).endsWith("/apply"))
    return new Response("{}", { status: 200 });
  const body = JSON.parse(init?.body ?? "{}");
  h.applies.push(body);
  return new Response(
    JSON.stringify({
      roomId: `whiteboard-${DOC}`,
      applied: true,
      target: "live",
      put: body.put?.length ?? 0,
      patched: body.patch?.length ?? 0,
      removed: body.remove?.length ?? 0,
      skipped: [],
    }),
    { status: 200 }
  );
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithGrant,
  setPodClassDefault,
} from "@synap/database";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { placeOnBoard } from "../../../services/whiteboards/place-on-board.js";

const AI_PRESET = grantOfScope({
  permissions: [
    ...GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
      .permissions,
  ],
});
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** As the key-auth doors run a request: the key's grant, then its agent. */
const asKey = <T>(fn: () => Promise<T>) =>
  runWithGrant(AI_PRESET, () => runWithActingAgent(AGENT, fn));
const door = (request: Parameters<typeof placeOnBoard>[0]["request"]) =>
  asKey(() =>
    placeOnBoard({
      viewId: VIEW,
      userId: OWNER,
      agentUserId: AGENT,
      request,
    })
  );
const proposalsOf = async () =>
  (
    await q<{ target_type: string; proposal_type: string; status: string }>(
      `select target_type, proposal_type, status from proposals where agent_user_id = $1 and target_type = 'whiteboard' order by created_at`,
      [AGENT]
    )
  ).rows;

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner@x.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
    [AGENT, "agent@x.test", OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, provisioning_status, settings) values ($1,'Space',$2,'ready','{}'::jsonb)`,
    [SPACE, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), SPACE, OWNER]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$2,$3,'task','Acme')`,
    [ENTITY, OWNER, SPACE]
  );
  // The pod default every pod is seeded with (migration 0282, founder
  // 2026-09-28): an agent acts directly on an easily-reversible write, which
  // is what makes `whiteboard/place` apply at once. Without it the same create
  // is a proposal (the ladder's default for an agent).
  await setPodClassDefault(h.db as never, {
    pattern: REVERSIBLE_CLASS_PATTERN,
    enabled: true,
    userId: OWNER,
  });
}, 120_000);

beforeEach(() => {
  h.applies = [];
});

describe("the place door through the real gate, as an AI-preset key", () => {
  it("a removal is ONE pending proposal, never a 403, and nothing is written", async () => {
    const result = await door({ remove: ["shape:frame"] });
    expect(result.removed).toMatchObject({ status: "proposed" });
    expect(h.applies).toHaveLength(0);
    const rows = await proposalsOf();
    expect(rows.at(-1)).toMatchObject({
      target_type: "whiteboard",
      proposal_type: "delete_shapes",
      status: "pending",
    });
  });

  it("an update is a proposal, nothing written", async () => {
    const result = await door({ update: [{ shapeId: "shape:s", x: 5 }] });
    expect(result.updated).toMatchObject({ status: "proposed" });
    expect(h.applies).toHaveLength(0);
  });

  it("a create plus a removal writes the create once and proposes the removal", async () => {
    const result = await door({
      resources: [{ kind: "entity", entityId: ENTITY }],
      remove: ["shape:frame"],
    });
    expect(result.created).toMatchObject({ status: "applied", pending: true });
    expect(result.removed).toMatchObject({ status: "proposed" });
    expect(h.applies).toHaveLength(1);
    expect(h.applies[0]).toHaveProperty("put");
    expect(h.applies[0]).not.toHaveProperty("remove");
  });

  it("CONTROL: the grant alone DENIES the removal (the proposal above is the door's doing)", async () => {
    const { checkPermissionOrPropose } =
      await import("../../../utils/permission-check.js");
    const verdict = await asKey(() =>
      checkPermissionOrPropose({
        userId: OWNER,
        agentUserId: AGENT,
        source: "intelligence",
        workspaceId: SPACE,
        subjectType: "whiteboard",
        action: "delete_shapes",
        data: { viewId: VIEW, shapeIds: ["shape:frame"] },
      })
    );
    expect(verdict).toMatchObject({ denied: true });
  });
});
