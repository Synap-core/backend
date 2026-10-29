/**
 * A capability the PERSON built, whose verb declares `search_web`, is the
 * provider an unnamed `web.search` runs — not only catalog ones.
 *
 * Drives the REAL provider lookup (PGlite → `listCapabilities` →
 * `foldVerbsByIntent` → `searchWeb`), so a registry filter, a fold that drops
 * a user's own skill row, or a lookup keyed on another intent fails here. Only
 * the run itself (`execute`) and the catalog read are stubbed: what is under
 * test is WHICH verb runs, not the run door.
 *
 * NOT covered: the IS-native manifest (stubbed to `[]`, as in
 * `builtin-skill-intent-reachability.pglite.test.ts`), and the authoring door
 * that writes the skill row (`synap_create_skill`): the row is inserted with
 * the shape that door stores (pod scope, the person's `user_id`, `intent`).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultActiveService: async () => {
      throw new Error("no IS in test");
    },
  };
});

import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import { searchWeb } from "./web-search.js";

const U = randomUUID();
const WS = randomUUID();

const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<{ rows: Array<Record<string, any>> }>;

/** A pod-scope code skill the person owns, in a capability of their own. */
async function ownSkill(name: string, intent: string | null, pack: string) {
  const id = randomUUID();
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata, intent)
     values ($1,$2,'code','active',true,'pod',$3,$4,'{"readOnly":true}'::jsonb,$5)`,
    [id, name, WS, U, intent]
  );
  await q(
    `insert into links (from_type, from_id, to_type, to_id, link_type) values ('skill',$1,'capability',$2,'member_of')`,
    [id, pack]
  );
}

const run = () => {
  const execute = vi.fn(async (_input: { verbId: string }) => ({
    kind: "run" as const,
    skillId: "s",
    result: { results: [] },
    ackState: "applied" as const,
  }));
  return { execute: execute as never, spy: execute };
};

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(
    pgliteSchemaDdl([
      s.tools!,
      s.skills!,
      s.vaultGrants!,
      s.links!,
      s.secrets!,
      s.capabilities!,
      s.intelligenceCommands!,
      s.workspaces!,
      s.workspaceMembers!,
      s.podMembers!,
      s.users!,
      s.projectMembers!,
      s.governanceRules!,
    ])
  );
  await q(`insert into users (id, email) values ($1,'u@x')`, [U]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'WS',$2,'{}'::jsonb)`,
    [WS, U]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'editor')`,
    [WS, U]
  );
  const mine = randomUUID();
  const notes = randomUUID();
  await q(`insert into capabilities (id, name) values ($1,'My search')`, [
    mine,
  ]);
  await q(`insert into capabilities (id, name) values ($1,'My notes')`, [
    notes,
  ]);
  await ownSkill("my_web_search", "search_web", mine);
  // An outside-corpus search and an unannotated verb: never web providers.
  await ownSkill("my_notes_search", "search_external", notes);
  await ownSkill("my_notes_digest", null, notes);
});

describe("web.search — a person's own search_web verb is its provider", () => {
  it("lists it as the one provider, and an unnamed search runs it", async () => {
    const { execute, spy } = run();
    const out = await searchWeb(
      { userId: U, workspaceId: WS, agentUserId: null, sessionId: null },
      "synap",
      {},
      {
        execute,
        listCatalog: async () => {
          throw new Error("the catalog is read only when nothing is installed");
        },
      }
    );

    expect(out.providers.map((p) => p.verbId)).toEqual(["my_web_search"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      verbId: "my_web_search",
      parameters: { query: "synap" },
      userId: U,
    });
    expect(out.search).toMatchObject({
      status: "ok",
      provider: "my_web_search",
    });
  });
});
