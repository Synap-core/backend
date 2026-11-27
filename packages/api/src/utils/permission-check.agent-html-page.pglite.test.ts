/**
 * An AI's executable HTML page is always reviewed (decision D1 default,
 * surfaces review architecture S1, 27 Nov 2026): `document/create` with
 * `type: "html"` is floored at rung 2.09, as `cell/create` is, even where a
 * rule auto-approves document creates.
 *
 * Driven through the REAL gate (`previewPermissionDecision`: the same ladder
 * `checkPermissionOrPropose` runs, without filing), the real rule store
 * (`governance_rules`), the real agent row and membership, on PGlite.
 *
 * Rows, each ruling out a wrong outcome:
 *  - control: an agent's MARKDOWN document create under an `auto` rule is
 *    executed (rules out "this setup proposes everything", which would make
 *    the html row prove nothing);
 *  - the same agent's HTML document create under the same rule: proposed
 *    (rules out "a rule on document.create lets an agent's page land
 *    unreviewed");
 *  - an unattributed AI write (`source: "intelligence"`, no agent) under an
 *    `any` rule: markdown executed, html proposed (rules out "only the agent
 *    ladder floors it");
 *  - the person's own html page: executed (rules out "a person's page is
 *    reviewed too").
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
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

vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: "event" }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));

import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { previewPermissionDecision } from "./permission-check.js";

const USER = randomUUID();
const AGENT = randomUUID();
const W = randomUUID();

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@x.test`,
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type) values ($1, $2, 'agent', $3, 'claude-code')`,
    [AGENT, `${AGENT}@x.test`, USER]
  );
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'Space', '{}'::jsonb)`,
    [W, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $1, $3, 'editor')`,
    [W, USER, AGENT]
  );
  // The person auto-approved document creates: for this agent, and for any
  // AI principal (the anonymous path reads `any` rules only).
  await q(
    `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by, created_at)
     values (gen_random_uuid(), 'agent', $1, 'pod', 'action', 'document.create', 'auto', $2, now()),
            (gen_random_uuid(), 'any', null, 'pod', 'action', 'document.create', 'auto', $2, now())`,
    [AGENT, USER]
  );
}, 120_000);

const create = (type: "markdown" | "html", who: Record<string, unknown>) =>
  previewPermissionDecision({
    userId: USER,
    workspaceId: W,
    subjectType: "document",
    action: "create",
    ...who,
    data: {
      id: randomUUID(),
      title: "Page",
      type,
      content: type === "html" ? "<p>hi</p>" : "hi",
      workspaceId: W,
    },
  } as never);

describe("an AI's HTML page is always reviewed (D1)", () => {
  it("control: the agent's markdown document under an auto rule is executed", async () => {
    expect(
      await create("markdown", { agentUserId: AGENT, source: "intelligence" })
    ).toEqual({ decision: "execute" });
  });

  it("the agent's html page under the same rule: proposed", async () => {
    expect(
      await create("html", { agentUserId: AGENT, source: "intelligence" })
    ).toEqual({ decision: "propose" });
  });

  it("an unattributed AI write under an `any` rule: markdown executed, html proposed", async () => {
    expect(await create("markdown", { source: "intelligence" })).toEqual({
      decision: "execute",
    });
    expect(await create("html", { source: "intelligence" })).toEqual({
      decision: "propose",
    });
  });

  it("the person's own html page: executed", async () => {
    expect(await create("html", {})).toEqual({ decision: "execute" });
  });
});
