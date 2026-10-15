/**
 * A reader's declared URLs (`skills.url_patterns`, 0330) REACH the registry
 * rows `listCapabilities` returns — on the reader's own skill row AND on the
 * verb of the tool it requires — because that is where the url-reader resolver
 * reads them. Driven from real rows through the real reader (PGlite); nothing
 * downstream is hand-built. A verb whose skill declares none carries no key.
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
// Deterministic read: the IS-native manifest fetch degrades to `[]` when the IS
// is unreachable (its documented behaviour). See "what it does not cover" (a).
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
import { listCapabilities } from "./capability-registry.js";

const U = randomUUID();
const WS = randomUUID();
const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<{ rows: Array<Record<string, any>> }>;

async function skill(
  name: string,
  urlPatterns: string[] | null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata, url_patterns)
     values ($1,$2,'code','active',true,'pod',$3,$4,'{}'::jsonb,$5)`,
    [id, name, WS, U, urlPatterns]
  );
  return id;
}

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
  // A tool-less reader (the builtin ladder's shape) and a non-reader.
  await skill("web.read", ["*"]);
  await skill("entity.query", null);
  // A tool-backed reader: the verb lives on the tool's catalog (id = skill name).
  const readerId = await skill("capture_social_post", [
    "instagram.com/p/*",
    "tiktok.com/@*/video/*",
  ]);
  const toolId = randomUUID();
  await q(
    `insert into tools (id, name, kind, approved, status, workspace_id, created_by, capabilities)
     values ($1,'apify','api',true,'active',$2,$3,$4::jsonb)`,
    [
      toolId,
      WS,
      U,
      JSON.stringify([
        {
          id: "capture_social_post",
          label: "Read a post",
          kind: "read",
          govDefault: "propose",
        },
      ]),
    ]
  );
  await q(
    `insert into links (from_type, from_id, to_type, to_id, link_type) values ('skill',$1,'tool',$2,'requires')`,
    [readerId, toolId]
  );
});

describe("reader URL patterns reach the registry rows", () => {
  it("a tool-less reader's own verb carries its patterns; a non-reader carries no key", async () => {
    const caps = await listCapabilities(
      { workspaceId: WS, userId: U },
      { limit: null }
    );
    const reader = caps.find((c) => c.name === "web.read");
    const plain = caps.find((c) => c.name === "entity.query");
    expect(
      reader,
      "the reader row never reached listCapabilities"
    ).toBeDefined();
    expect(
      plain,
      "the non-reader row never reached listCapabilities"
    ).toBeDefined();
    expect(reader!.verbs?.[0]?.urlPatterns).toEqual(["*"]);
    expect(plain!.verbs?.[0]).toBeDefined();
    expect("urlPatterns" in plain!.verbs![0]!).toBe(false);
  });

  it("a tool-backed reader's verb on the TOOL row carries its patterns", async () => {
    const caps = await listCapabilities(
      { workspaceId: WS, userId: U },
      { limit: null }
    );
    const tool = caps.find((c) => c.name === "apify");
    expect(tool, "the tool row never reached listCapabilities").toBeDefined();
    const verb = tool!.verbs?.find((v) => v.id === "capture_social_post");
    expect(verb, "the tool's catalog verb is missing").toBeDefined();
    expect(verb!.urlPatterns).toEqual([
      "instagram.com/p/*",
      "tiktok.com/@*/video/*",
    ]);
  });
});
