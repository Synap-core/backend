/**
 * Hub REST `POST /skills/:id/dry-run` previews only a skill the CALLER can see.
 *
 * The runtime loads a skill by id with no lens (`runSkillInSandbox`), and a
 * dry-run is not harmless: its reads are real, under the caller's floor, and
 * the result goes back to the caller. When the pod took the dry-run over from
 * the Intelligence Service (which read the skill AS the user), the lens moved
 * into this route: `visibleSkillsAnyWorkspaceWhere(acting.userId)`. Without it,
 * person B could run person A's private skill by its id.
 *
 * Real: the route, the skills / workspace / membership rows (PGlite), the
 * visibility predicate. Spied: `runSkill` (the one skill door), so a case can
 * say whether anything ran.
 *
 * Discriminating rows: A's `user`-scope skill and A's skill in A's private
 * space (both hidden from B: wrong rule "any skill by id"), a `pod`-scope
 * skill (shown to B: wrong rule "only your own"), and A's own skills (shown
 * to A: the lens is not simply "nothing").
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    runSkill: vi.fn(async (_args: Record<string, unknown>) => ({
      success: true,
      result: "previewed",
      dryRunEffects: [],
      executionTimeMs: 1,
    })),
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
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../../services/skills/run-skill.js", () => ({
  runSkill: (args: Record<string, unknown>) => h.runSkill(args),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import { registerSkillsCrudRoutes } from "./skills-crud.js";

const A = randomUUID(); // the skill's owner
const B = randomUUID(); // another person on the pod
const WA = randomUUID(); // A's private space
const A_PRIVATE = randomUUID();
const A_IN_SPACE = randomUUID();
const POD_WIDE = randomUUID();

const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<unknown>;

async function codeSkill(
  id: string,
  owner: string,
  scope: "user" | "workspace" | "pod",
  workspaceId: string | null = null
) {
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, code)
     values ($1,$2,'code','active',true,$3,$4,$5,'return 1;')`,
    [id, `skill_${id.slice(0, 8)}`, scope, workspaceId, owner]
  );
}

function appAs(userId: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, userId as never);
    await next();
  });
  registerSkillsCrudRoutes(app as never);
  return app;
}

async function dryRun(userId: string, skillId: string) {
  const res = await appAs(userId).request(`/skills/${skillId}/dry-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parameters: {} }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(
    pgliteSchemaDdl([
      s.skills!,
      s.workspaces!,
      s.workspaceMembers!,
      s.podMembers!,
      s.users!,
      s.projectMembers!,
    ])
  );
  await q(`insert into users (id, email) values ($1,'a@x'), ($2,'b@x')`, [
    A,
    B,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'A private',$2,'{}'::jsonb)`,
    [WA, A]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`,
    [WA, A]
  );
  await codeSkill(A_PRIVATE, A, "user");
  await codeSkill(A_IN_SPACE, A, "workspace", WA);
  await codeSkill(POD_WIDE, A, "pod");
});

beforeEach(() => h.runSkill.mockClear());

describe("POST /skills/:id/dry-run previews only a skill the caller can see", () => {
  it("B cannot preview A's private skill: 404, and nothing runs", async () => {
    const res = await dryRun(B, A_PRIVATE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(`Skill not found: ${A_PRIVATE}`);
    expect(h.runSkill).not.toHaveBeenCalled();
  });

  it("B cannot preview a skill in A's private space: 404, and nothing runs", async () => {
    const res = await dryRun(B, A_IN_SPACE);
    expect(res.status).toBe(404);
    expect(h.runSkill).not.toHaveBeenCalled();
  });

  it("B can preview a pod-wide skill, as B (non-vacuity: the lens is not 'own only')", async () => {
    const res = await dryRun(B, POD_WIDE);
    expect(res.status).toBe(200);
    expect(h.runSkill).toHaveBeenCalledTimes(1);
    expect(h.runSkill.mock.calls[0]![0]).toMatchObject({
      skillId: POD_WIDE,
      userId: B,
      dryRun: true,
    });
  });

  it("A previews A's own skills (non-vacuity: the lens is not 'nothing')", async () => {
    for (const id of [A_PRIVATE, A_IN_SPACE]) {
      const res = await dryRun(A, id);
      expect(res.status).toBe(200);
    }
    expect(h.runSkill).toHaveBeenCalledTimes(2);
  });
});
