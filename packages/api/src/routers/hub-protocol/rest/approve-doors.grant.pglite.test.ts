/**
 * Turning a skill or a tool on or off over Hub REST is bounded by the KEY'S
 * GRANT (ticket 1158dffe). `POST /skills/:id/approve` and
 * `POST /tools/:id/approve` checked only the scope and refused agent keys,
 * then called the owner-gated tRPC procedure with the person's context: a pod
 * app acting as the person (an `app_person` token, bounded by what the person
 * ticked) switched pod-wide verbs it was never given (T13 in
 * `services/app-person-token.ts`: an app never holds a review verb).
 *
 * Driven through the REAL routes, behind a stand-in for the auth middleware
 * that sets what the real one sets for such a key (the person as `userId`, no
 * agent) and enters the key's grant (`runWithGrant`). The rung under test is
 * the REAL `grantWriteDenial` reading the REAL skill/tool row's space on
 * PGlite. The tRPC procedure behind the door is a spy: it is reached or not,
 * and its own owner / presence gate is tested elsewhere.
 *
 * Not covered: the real `hubAuthMiddleware` (`resolveKeyIdentity`), the
 * presence gate, the owner role check inside `setApproved`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  setApproved: [] as Array<{ door: string; id: string; approved: boolean }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({
      setApproved: async (i: { id: string; approved: boolean }) => {
        h.setApproved.push({ door: "skill", ...i });
        return {};
      },
    }),
  },
}));
vi.mock("../../tools.js", () => ({
  toolsRouter: {
    createCaller: () => ({
      setApproved: async (i: { id: string; approved: boolean }) => {
        h.setApproved.push({ door: "tool", ...i });
        return {};
      },
    }),
  },
}));
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createHubProtocolCallerContext: async () => ({}) };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { runWithGrant, type KeyGrant } from "@synap/database";
import { skills, tools } from "@synap/database/schema";
import { registerSkillsCrudRoutes } from "./skills-crud.js";
import { registerToolsRoutes } from "./tools.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID(); // the person
const W = randomUUID(); // the space the app was given
const W2 = randomUUID(); // another space of A's
const SKILL_POD = randomUUID(); // a pod-wide skill (no space)
const SKILL_W = randomUUID(); // a skill of W
const SKILL_W2 = randomUUID(); // a skill of W2
const TOOL_POD = randomUUID();
const TOOL_W = randomUUID();

const SCOPES = ["hub-protocol.read", "hub-protocol.write"];

/** The request as the auth middleware leaves it for the person's key. */
function keyApp(grant: KeyGrant | null) {
  const app = new OpenAPIHono();
  app.use("/*", async (c, next) => {
    c.set("userId" as never, A as never);
    c.set("scopes" as never, SCOPES as never);
    c.set("keyType" as never, "app_person" as never);
    return grant ? runWithGrant(grant, () => next()) : next();
  });
  registerSkillsCrudRoutes(app as never);
  registerToolsRoutes(app as never);
  return app;
}

/** A pod app's grant: what the person ticked, in the spaces they gave it. */
const appGrant = (permissions: string[], workspaceIds = [W]): KeyGrant => ({
  clientId: "studio.example.com",
  scopes: [{ permissions, workspaceIds }],
});

const approve = (
  app: OpenAPIHono,
  door: "skills" | "tools",
  id: string,
  approved: boolean
) =>
  app.request(`/${door}/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved }),
  });

beforeAll(async () => {
  for (const t of [skills, tools] as PgTable[]) await h.client!.exec(ddlFor(t));
  for (const [id, ws] of [
    [SKILL_POD, null],
    [SKILL_W, W],
    [SKILL_W2, W2],
  ] as const) {
    await h.client!.query(
      `insert into skills (id, name, workspace_id, user_id) values ($1, $2, $3, $4)`,
      [id, `skill-${id.slice(0, 8)}`, ws, A]
    );
  }
  for (const [id, ws] of [
    [TOOL_POD, null],
    [TOOL_W, W],
  ] as const) {
    await h.client!.query(
      `insert into tools (id, name, workspace_id, created_by) values ($1, $2, $3, $4)`,
      [id, `tool-${id.slice(0, 8)}`, ws, A]
    );
  }
}, 60_000);

beforeEach(() => {
  h.setApproved.length = 0;
});

describe("an app acting as the person never switches a verb its grant does not name", () => {
  const reader = () =>
    keyApp(appGrant(["entity.person.read", "entity.person.create"]));

  it.each([
    ["skills", SKILL_POD, false],
    ["skills", SKILL_POD, true],
    ["skills", SKILL_W, false],
    ["tools", TOOL_POD, false],
    ["tools", TOOL_W, true],
  ] as const)(
    "%s %s approved=%s → 403 by the grant, the procedure never reached",
    async (door, id, approved) => {
      const res = await approve(reader(), door, id, approved);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(
        new RegExp(
          `grant does not allow "${door === "skills" ? "skill" : "tool"}\\.approve"`
        )
      );
      expect(h.setApproved).toEqual([]);
    }
  );

  it("a grant naming skill.approve in W reaches a skill of W, never a pod-wide one or one of W2", async () => {
    const app = keyApp(appGrant(["skill.approve"]));
    expect((await approve(app, "skills", SKILL_W, false)).status).toBe(200);
    expect(h.setApproved).toEqual([
      { door: "skill", id: SKILL_W, approved: false },
    ]);
    expect((await approve(app, "skills", SKILL_POD, false)).status).toBe(403);
    expect((await approve(app, "skills", SKILL_W2, false)).status).toBe(403);
    expect(h.setApproved).toHaveLength(1);
  });
});

describe("what stays allowed", () => {
  it("a signed-in person (no grant) and an unpinned full-access key reach the procedure", async () => {
    expect(
      (await approve(keyApp(null), "skills", SKILL_POD, false)).status
    ).toBe(200);
    const full: KeyGrant = { clientId: null, scopes: [{ permissions: ["*"] }] };
    expect((await approve(keyApp(full), "tools", TOOL_POD, false)).status).toBe(
      200
    );
    expect(h.setApproved.map((c) => c.id)).toEqual([SKILL_POD, TOOL_POD]);
  });
});
