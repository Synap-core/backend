/**
 * POST /links ENDPOINT FLOOR — driven through the REAL route handler and the
 * REAL `checkLinkEndpointsVisible`, with every visibility predicate compiled
 * and executed as SQL on PGlite. Only the acting-context resolver and the
 * governance gate are stubbed (the gate files a proposal, so "accepted" means
 * a proposal was filed).
 *
 * The defect this pins: the door checked only workspace, `uses`-project and
 * `blocked_by`-session endpoints. Any other (type, id) went straight to
 * governance, so an agent could file an edge to an object it cannot see and
 * read its name back off its own proposal.
 *
 * For EVERY endpoint type: a visible id is accepted; an invisible id and a
 * nonexistent id are refused with a byte-identical response (no existence
 * oracle); `participant` / `source` are refused outright.
 *
 * What this CANNOT see: production Postgres (PGlite tables carry no FKs, NOT
 * NULL, defaults or enums), the approval path after a proposal is filed, and
 * lens-scoped variants of each predicate (the door reads user-wide).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  actingWorkspaceId: "" as string,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schemaModule = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  // With the schema, so the relational `db.query.*` API the workspace
  // membership gate (`getWorkspaceMembership`) reads is available.
  return { ...actual, db: drizzle(client, { schema: schemaModule }) };
});

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveActingContext: vi.fn(async () => ({
      ok: true,
      userId: VIEWER,
      workspaceId: h.actingWorkspaceId,
      role: "owner",
    })),
    resolveActorId: vi.fn(async (_a: unknown, userId: string) => ({
      actorId: userId,
    })),
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({
    granted: false,
    proposalId: "prop-1",
    reviewPath: "/open/prop-1",
    reviewUrl: "https://pod.example/open/prop-1",
  })),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { registerLinksRoutes } from "./links.js";
import type { HubHono, HubVariables } from "./_shared.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const VIEWER_AGENT_USER = "viewer-agent-user";
const OTHER_AGENT_USER = "other-agent-user";

const id = () => randomUUID();
/** type → [visible id, invisible id] */
const FIXTURE: Record<string, [string, string]> = {
  workspace: [WS_SEEN, WS_HIDDEN],
  playbook: [id(), id()],
  tool: [id(), id()],
  automation: [id(), id()],
  channel: [id(), id()],
  project: [id(), id()],
  command: [id(), id()],
  entity: [id(), id()],
  secret: [id(), id()],
  session: [id(), id()],
  skill: [id(), id()],
  capability: [id(), id()],
  agent: [id(), id()],
};

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  const f = FIXTURE;
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Seen WS',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [id(), WS_SEEN, VIEWER, id(), WS_HIDDEN, OTHER]
  );
  // Workspace-ruled config: seen in the viewer's workspace, hidden in OTHER's.
  for (const table of ["playbooks", "tools", "automations"]) {
    const [seen, hidden] =
      f[
        table === "playbooks"
          ? "playbook"
          : table === "tools"
            ? "tool"
            : "automation"
      ]!;
    await q(
      `insert into ${table} (id, name, workspace_id) values ($1,'seen',$2),($3,'hidden',$4)`,
      [seen, WS_SEEN, hidden, WS_HIDDEN]
    );
  }
  await q(
    `insert into channels (id, title, user_id, workspace_id, channel_type) values ($1,'seen',$2,null,'personal'),($3,'hidden',$4,null,'personal')`,
    [f.channel![0], VIEWER, f.channel![1], OTHER]
  );
  // NULL-workspace = owner-private for projects / entities / sessions.
  await q(
    `insert into projects (id, name, user_id, workspace_id) values ($1,'seen',$2,null),($3,'hidden',$4,null)`,
    [f.project![0], VIEWER, f.project![1], OTHER]
  );
  await q(
    `insert into entities (id, title, user_id, workspace_id) values ($1,'seen',$2,null),($3,'hidden',$4,null)`,
    [f.entity![0], VIEWER, f.entity![1], OTHER]
  );
  await q(
    `insert into focus_sessions (id, goal, user_id, workspace_id) values ($1,'seen',$2,null),($3,'hidden',$4,null)`,
    [f.session![0], VIEWER, f.session![1], OTHER]
  );
  // A user-scoped command is its creator's alone.
  await q(
    `insert into intelligence_commands (id, title, created_by, workspace_id, shared_scope) values ($1,'seen',$2,$3,'user'),($4,'hidden',$5,$3,'user')`,
    [f.command![0], VIEWER, WS_SEEN, f.command![1], OTHER]
  );
  await q(`insert into secrets (id, user_id) values ($1,$2),($3,$4)`, [
    f.secret![0],
    VIEWER,
    f.secret![1],
    OTHER,
  ]);
  await q(
    `insert into skills (id, name, slug, user_id, scope) values ($1,'seen','seen',$2,'user'),($3,'hidden','hidden',$4,'user')`,
    [f.skill![0], VIEWER, f.skill![1], OTHER]
  );
  await q(
    `insert into capabilities (id, name, created_by, workspace_id) values ($1,'seen',$2,$3),($4,'hidden',$5,$6)`,
    [f.capability![0], VIEWER, WS_SEEN, f.capability![1], OTHER, WS_HIDDEN]
  );
  // Agents: an adjunct's owner is its actor-user's `created_by_user_id`.
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,'a@x','agent',$2),($3,'b@x','agent',$4)`,
    [VIEWER_AGENT_USER, VIEWER, OTHER_AGENT_USER, OTHER]
  );
  await q(
    `insert into agents (id, name, owner_type, user_id) values ($1,'seen','user',$2),($3,'hidden','user',$4)`,
    [f.agent![0], VIEWER_AGENT_USER, f.agent![1], OTHER_AGENT_USER]
  );
});

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", VIEWER);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerLinksRoutes(a);
  return a;
}

/** `entity --about--> <type>` (or `<type> --about--> entity` for workspace,
 * which needs an owned entity on the other end either way). */
async function post(toType: string, toId: string) {
  const res = await app().request("/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: WS_SEEN,
      fromType: "entity",
      fromId: FIXTURE.entity![0],
      toType,
      toId,
      linkType: "about",
    }),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /links — every endpoint type is floored before governance", () => {
  beforeEach(() => {
    vi.mocked(checkPermissionOrPropose).mockClear();
    h.actingWorkspaceId = WS_SEEN;
  });

  it.each(Object.keys(FIXTURE))(
    "%s: visible → proposal filed; invisible ≡ nonexistent → refused, nothing filed",
    async (type) => {
      const [seen, hidden] = FIXTURE[type]!;

      const accepted = await post(type, seen);
      expect([type, accepted.status, accepted.body.status]).toEqual([
        type,
        202,
        "proposed",
      ]);
      expect(checkPermissionOrPropose).toHaveBeenCalledTimes(1);

      const invisible = await post(type, hidden);
      const missing = await post(type, randomUUID());
      expect(invisible.status).toBeGreaterThanOrEqual(400);
      // Identical refusal, modulo the id itself for the workspace wording
      // (which echoes the caller-supplied id, never anything about the row).
      const scrub = (r: { status: number; body: { error: string } }) => ({
        status: r.status,
        error: r.body.error
          .replace(hidden, "<id>")
          .replace(/[0-9a-f-]{36}/, "<id>"),
      });
      expect(scrub(missing)).toEqual(scrub(invisible));
      // Only the one accepted call reached governance.
      expect(checkPermissionOrPropose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["participant", "source"])(
    "%s has no canonical visibility check — refused even for the caller's own id",
    async (type) => {
      const res = await post(type, VIEWER);
      expect(res.status).toBe(404);
      expect(checkPermissionOrPropose).not.toHaveBeenCalled();
    }
  );

  it("a non-uuid id is refused, not a 500", async () => {
    const res = await post("playbook", "not-a-uuid");
    expect(res.status).toBe(404);
  });

  it("the FROM endpoint is floored too", async () => {
    const res = await app().request("/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: WS_SEEN,
        fromType: "entity",
        fromId: FIXTURE.entity![1],
        toType: "tool",
        toId: FIXTURE.tool![0],
        linkType: "about",
      }),
    });
    expect(res.status).toBe(404);
    expect(checkPermissionOrPropose).not.toHaveBeenCalled();
  });
});
