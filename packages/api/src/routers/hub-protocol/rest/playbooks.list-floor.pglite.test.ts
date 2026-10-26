/**
 * SECURITY — Hub REST `GET /playbooks` lists on the user floor: member
 * workspaces + pod-wide templates, never another user's workspace.
 *
 * Driven through the REAL route → real `playbook-doors.ts` → real
 * `playbooksRouter.listAllPage` → real access-layer predicate, on PGlite with
 * real `playbooks` / `workspaces` / `workspace_members` tables. Nothing about
 * visibility is mocked; the assertion is on which rows come back.
 *
 * A SCOPED key (an app's own agent, a narrowed agent key) reads both doors
 * through the same seams, ANDed with its grant (`grant-door-fence.ts` lists
 * them as seamed): it sees the playbooks its grant reads, and a method's
 * project count never counts what the grant does not read.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      playbooks: schema.playbooks,
      workspaces: schema.workspaces,
      workspaceMembers: schema.workspaceMembers,
    } as never,
  });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  playbooks,
  workspaces,
  workspaceMembers,
  podMembers,
  users,
  projectMembers,
  projects,
  projectTracks,
} from "@synap/database/schema";
import { runWithGrant, type KeyGrant } from "@synap/database";

const { registerPlaybooksRoutes } = await import("./playbooks.js");

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** Same column-only DDL as `capabilities.dry-run-visibility.pglite.test.ts`. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const USER = randomUUID();
const OTHER = randomUUID();
const WS_MINE = randomUUID();
const WS_OTHER = randomUUID();
/** USER's second space: outside the scoped key's grant. */
const WS_MINE_2 = randomUUID();
/** A METHOD (scope project) in WS_MINE, run as a track by a WS_MINE_2 project. */
const METHOD = randomUUID();

async function seedPlaybook(
  name: string,
  workspaceId: string | null,
  createdBy: string,
  id: string = randomUUID(),
  scope = "session"
): Promise<void> {
  await h.client!.query(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status, scope, created_at)
     values ($1,$2,$3,$4,'Do it','active', $5, now())`,
    [id, workspaceId, createdBy, name, scope]
  );
}

beforeAll(async () => {
  for (const t of [
    playbooks,
    workspaces,
    workspaceMembers,
    podMembers,
    users,
    projectMembers,
    projects,
    projectTracks,
  ] as PgTable[]) {
    await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into workspaces (id, owner_id, settings) values ($1,$2,'{}'::jsonb),($3,$4,'{}'::jsonb)`,
    [WS_MINE, USER, WS_OTHER, OTHER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3),($4,$5,$6)`,
    [randomUUID(), WS_MINE, USER, randomUUID(), WS_OTHER, OTHER]
  );
  await seedPlaybook("mine", WS_MINE, USER);
  await seedPlaybook("other-private", WS_OTHER, OTHER);
  await seedPlaybook("pod-template", null, OTHER);
  await h.client!.query(
    `insert into workspaces (id, owner_id, settings) values ($1,$2,'{}'::jsonb)`,
    [WS_MINE_2, USER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
    [randomUUID(), WS_MINE_2, USER]
  );
  await seedPlaybook("mine-2", WS_MINE_2, USER);
  await seedPlaybook("method", WS_MINE, USER, METHOD, "project");
  const project = randomUUID();
  await h.client!.query(
    `insert into projects (id, user_id, workspace_id, name) values ($1,$2,$3,'Launch')`,
    [project, USER, WS_MINE_2]
  );
  await h.client!.query(
    `insert into project_tracks (id, project_id, user_id, playbook_id, name, status) values ($1,$2,$3,$4,'Launch track','active')`,
    [randomUUID(), project, USER, METHOD]
  );
});

function appAs(userId: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    c.set("userId" as never, userId as never);
    await next();
  });
  registerPlaybooksRoutes(app as never);
  return app;
}

async function listNames(userId: string, query = ""): Promise<string[]> {
  const res = await appAs(userId).request(`/playbooks${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { playbooks: Array<{ name: string }> };
  return body.playbooks.map((p) => p.name).sort();
}

describe("SECURITY — GET /playbooks lists on the user floor", () => {
  it("a member sees their workspace's playbooks and pod-wide templates — never another user's workspace", async () => {
    const names = await listNames(USER);
    expect(names).toContain("mine");
    expect(names).toContain("pod-template");
    expect(names).not.toContain("other-private");
  });

  it("the other user sees their own private playbook (the fixture is visible to someone)", async () => {
    expect(await listNames(OTHER)).toContain("other-private");
  });

  it("naming a non-member workspace narrows, it never widens", async () => {
    const names = await listNames(USER, `?workspaceId=${WS_OTHER}`);
    expect(names).not.toContain("other-private");
  });
});

/** A key that reads playbooks in WS_MINE only (an app's agent, as consented). */
const PLAYBOOKS_IN_MINE: KeyGrant = {
  scopes: [{ permissions: ["playbook.read"], workspaceIds: [WS_MINE] }],
  clientId: null,
};

async function getPlaybook(
  id: string,
  grant?: KeyGrant
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await runWithGrant(grant, () =>
    appAs(USER).request(`/playbooks/${id}`)
  );
  return { status: res.status, body: (await res.json()) as never };
}

describe("a scoped key reads GET /playbooks and GET /playbooks/:id through its grant", () => {
  it("lists only the playbooks its grant reads; a key with no playbook read lists none", async () => {
    const all = await listNames(USER);
    expect(all).toEqual(
      expect.arrayContaining(["method", "mine", "mine-2", "pod-template"])
    );
    expect(
      await runWithGrant(PLAYBOOKS_IN_MINE, () => listNames(USER))
    ).toEqual(["method", "mine"]);
    expect(
      await runWithGrant(
        {
          scopes: [{ permissions: ["entity.read"], workspaceIds: [WS_MINE] }],
          clientId: null,
        },
        () => listNames(USER)
      )
    ).toEqual([]);
  });

  it("gets one it reads; one outside its grant is not found", async () => {
    const [mine2] = (
      await h.client!.query<{ id: string }>(
        `select id from playbooks where name = 'mine-2'`
      )
    ).rows;
    expect((await getPlaybook(mine2!.id)).status).toBe(200);
    expect((await getPlaybook(mine2!.id, PLAYBOOKS_IN_MINE)).status).toBe(404);
    expect((await getPlaybook(METHOD, PLAYBOOKS_IN_MINE)).status).toBe(200);
  });

  it("a method's project count counts only projects and tracks the grant reads", async () => {
    // Without a grant the person's own floor counts the WS_MINE_2 project.
    expect((await getPlaybook(METHOD)).body.projectsUsingCount).toBe(1);
    // The key reads playbooks in WS_MINE, not projects or tracks.
    expect(
      (await getPlaybook(METHOD, PLAYBOOKS_IN_MINE)).body.projectsUsingCount
    ).toBe(0);
  });
});
