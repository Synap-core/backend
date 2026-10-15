/**
 * The url-reader door sees EVERY space the PERSON can see — at its seam:
 * real rows → the real `listCapabilities` (`allSpaces`, the `userVisibleWhere`
 * floor) → `listReadersForUrl` / `readUrl`. Only `execute` is a spy, so the
 * test can say WHICH space the verb would run in.
 *
 * Discriminating rows (each rules a plausible wrong rule out):
 *   - a reader installed in space S, item / caller at pod altitude → offered,
 *     and runs IN S (wrong rules: "pod altitude sees pod-wide only"; "run in
 *     the caller's lens" — a workspace skill is not found at null)
 *   - a reader in ANOTHER user's private space T → never offered (wrong rule:
 *     a hand-rolled join that skips the access floor)
 *   - the SAME person through an AGENT → the lens is kept (wrong rule: "the
 *     widening applies to every caller")
 *   - agent read first, person read second, same user + lens → different
 *     answers (wrong rule: a cache key without the mode)
 *
 * NOT covered, measured: bypassing ONLY the tools floor in the registry's
 * allSpaces read stays green here — a reader's URLs live on its SKILL, whose
 * own floor (`visibleSkillsAnyWorkspaceWhere`) still hides T's verb. Bypassing
 * the skills floor goes red (3 tests).
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
// The IS-native manifest degrades to `[]` when the IS is unreachable.
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
import {
  invalidateUrlReaderCache,
  listReadersForUrl,
  readUrl,
  type ReadUrlDeps,
} from "./url-readers.js";

const U = randomUUID(); // the person
const V = randomUUID(); // another user
const AGENT = randomUUID();
const S = randomUUID(); // U's space holding the reader pack
const W = randomUUID(); // U's other space (a Library item kept there)
const T = randomUUID(); // V's private space with its own reader
const IG = "https://www.instagram.com/p/C0ffee123/";
const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<{ rows: Array<Record<string, any>> }>;

const link = (
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  type: string
) =>
  q(
    `insert into links (from_type, from_id, to_type, to_id, link_type) values ($1,$2,$3,$4,$5)`,
    [fromType, fromId, toType, toId, type]
  );

/** A free, enabled reader pack installed IN `workspaceId` (container + tool + skill). */
async function readerPack(verb: string, workspaceId: string, owner: string) {
  const container = randomUUID();
  const toolId = randomUUID();
  const skillId = randomUUID();
  await q(
    `insert into capabilities (id, workspace_id, created_by, name, approved, template_key, metadata)
     values ($1,$2,$3,$4,true,$5,'{}'::jsonb)`,
    [container, workspaceId, owner, `${verb} pack`, verb]
  );
  await q(
    `insert into tools (id, name, kind, approved, status, workspace_id, created_by, capabilities)
     values ($1,$2,'api',true,'active',$3,$4,$5::jsonb)`,
    [
      toolId,
      `${verb}_api`,
      workspaceId,
      owner,
      JSON.stringify([
        { id: verb, label: "Read a post", kind: "read", govDefault: "auto" },
      ]),
    ]
  );
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata, url_patterns, intent)
     values ($1,$2,'code','active',true,'workspace',$3,$4,'{"readOnly":true}'::jsonb,$5,'read_webpage')`,
    [skillId, verb, workspaceId, owner, ["instagram.com/p/*"]]
  );
  await link("skill", skillId, "tool", toolId, "requires");
  await link("tool", toolId, "capability", container, "member_of");
  await link("skill", skillId, "capability", container, "member_of");
}

function spyDeps() {
  const execute = vi.fn(async (_input: { workspaceId: string | null }) => ({
    kind: "run" as const,
    skillId: "s1",
    result: { status: "ok", title: "A kept post", text: "Caption" },
    ackState: "applied" as never,
    correlationId: "corr-1",
  }));
  const d: ReadUrlDeps = {
    execute: execute as never,
    readBuiltin: async () => {
      throw new Error(
        "the built-in must not answer when a ready reader exists"
      );
    },
  };
  return { d, execute };
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
      s.cpCatalogCache!,
    ])
  );
  await q(`insert into users (id, email) values ($1,'u@x'), ($2,'v@x')`, [
    U,
    V,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values
       ($1,'S',$3,'{}'::jsonb), ($2,'W',$3,'{}'::jsonb), ($4,'T',$5,'{}'::jsonb)`,
    [S, W, U, T, V]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values
       ($1,$3,'owner'), ($2,$3,'owner'), ($4,$5,'owner')`,
    [S, W, U, T, V]
  );
  await readerPack("s_ig_read", S, U);
  await readerPack("t_ig_read", T, V);
  invalidateUrlReaderCache();
});

describe("the reader door sees every space the person can see", () => {
  it("pod altitude, the person: the reader installed in S is offered (ready); T's never", async () => {
    const offers = await listReadersForUrl(
      { userId: U, workspaceId: null },
      IG
    );
    expect(offers.map((o) => [o.readerId, o.state])).toEqual([
      ["s_ig_read", "ready"],
    ]);
  });

  it("a pod-wide Library item (allSpaces, workspaceId null) reads with S's reader, run IN S", async () => {
    const { d, execute } = spyDeps();
    const r = await readUrl(
      { userId: U, workspaceId: null, allSpaces: true },
      IG,
      { allowBilled: false },
      d
    );
    expect(r.read.status).toBe("ok");
    expect(r.read.via.verbId).toBe("s_ig_read");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      verbId: "s_ig_read",
      workspaceId: S,
      agentUserId: null,
    });
  });

  it("an item kept in ANOTHER of the person's spaces (W) still reads with S's reader, run in S", async () => {
    const { d, execute } = spyDeps();
    const r = await readUrl(
      { userId: U, workspaceId: W, allSpaces: true },
      IG,
      { allowBilled: false },
      d
    );
    expect(r.read.status).toBe("ok");
    expect(execute.mock.calls[0]![0]).toMatchObject({ workspaceId: S });
  });

  it("another user's space never leaks: V's reader in T is not offered to U, U's in S not to V", async () => {
    const mine = await listReadersForUrl(
      { userId: U, workspaceId: null, allSpaces: true },
      IG
    );
    expect(mine.map((o) => o.readerId)).not.toContain("t_ig_read");
    const theirs = await listReadersForUrl(
      { userId: V, workspaceId: null, allSpaces: true },
      IG
    );
    expect(theirs.map((o) => o.readerId)).toEqual(["t_ig_read"]);
  });

  it("an AGENT keeps its lens: at pod altitude it sees no space-installed reader, even asking for allSpaces", async () => {
    const agentCtx = {
      userId: U,
      workspaceId: null,
      agentUserId: AGENT,
      allSpaces: true,
    };
    expect(await listReadersForUrl(agentCtx, IG)).toEqual([]);
    // Naming the verb does not reach it either: not one of its readers.
    const { d, execute } = spyDeps();
    const r = await readUrl(
      agentCtx,
      IG,
      { reader: "s_ig_read", allowBilled: true, interactive: true },
      d
    );
    expect(r.read.status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("an agent lensed INTO S reads there, as before", async () => {
    const { d, execute } = spyDeps();
    const r = await readUrl(
      { userId: U, workspaceId: S, agentUserId: AGENT },
      IG,
      { allowBilled: false },
      d
    );
    expect(r.read.status).toBe("ok");
    expect(execute.mock.calls[0]![0]).toMatchObject({
      workspaceId: S,
      agentUserId: AGENT,
    });
  });

  it("the cache keys on the mode: an agent's lensed list never answers the person (same user, same lens)", async () => {
    invalidateUrlReaderCache();
    const agent = await listReadersForUrl(
      { userId: U, workspaceId: null, agentUserId: AGENT },
      IG
    );
    const person = await listReadersForUrl(
      { userId: U, workspaceId: null },
      IG
    );
    expect(agent).toEqual([]);
    expect(person.map((o) => o.readerId)).toEqual(["s_ig_read"]);
  });
});
