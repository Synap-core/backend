/**
 * `mcpServersRouter` management gate, on REAL tables.
 *
 * The defect: `setApproved`, `ping` and `delete` checked a role ONLY when the
 * row had a `workspaceId`. A POD-WIDE server (`workspace_id` null) let any
 * signed-in user through — and approval is what makes the Intelligence Service
 * inject the server's tools (`hub-protocol/rest/mcp-servers.ts` serves only
 * approved+enabled rows), so a non-admin approving a pod-wide server was
 * arbitrary tool injection.
 *
 * Driven through the real router via `createCaller`, against PGlite tables
 * generated from the Drizzle schema (`mcp_servers`, `workspaces`,
 * `workspace_members`). The pod-admin and workspace-role gates are NOT stubbed:
 * `isPodAdmin` / `getWorkspaceRole` read the seeded membership rows. Stubbed:
 * the MCP cache invalidation (lives in the heavy channels router), the IS
 * resolution + network for `ping`, split-brain and the audit log.
 *
 * Assertions read the ROW back, not the response, so a refused call that still
 * wrote would fail.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("./channels.js", () => ({ invalidateMcpCache: vi.fn() }));
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: async () => ({
    endpoint: "http://is.test",
    serviceApiKey: "k",
  }),
}));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import {
  mcpServers,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  users,
} from "@synap/database/schema";
import { mcpServersRouter } from "./mcp-servers.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary ? " primary key" : "";
    const def =
      c.name === "approved" || c.name === "enabled"
        ? ` default ${c.name === "enabled"}`
        : c.name === "args"
          ? " default '[]'"
          : c.name === "env"
            ? " default '{}'"
            : c.name === "created_at" || c.name === "updated_at"
              ? " default now()"
              : c.name === "status"
                ? " default 'unknown'"
                : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const POD_ADMIN_WS = randomUUID();
const WS = randomUUID();
const POD_ADMIN = "user-pod-admin";
const WS_OWNER = "user-ws-owner";
const WS_ADMIN = "user-ws-admin";
const NOBODY = "user-plain"; // signed in, member of nothing relevant
const WS_MEMBER = "user-ws-member"; // plain member of WS — sees rows, manages none

const caller = (userId: string) =>
  mcpServersRouter.createCaller({ authenticated: true, userId } as never);

async function seedServer(workspaceId: string | null, approved = false) {
  const id = randomUUID();
  await h.client!.query(
    `insert into mcp_servers (id, workspace_id, slug, name, transport, url, approved, enabled)
     values ($1, $2, $3, 'S', 'http', 'https://mcp.example.test', $4, true)`,
    [id, workspaceId, `s-${id.slice(0, 8)}`, approved]
  );
  return id;
}
const row = async (id: string) =>
  (
    await h.client!.query<{ approved: boolean; status: string | null }>(
      `select approved, status from mcp_servers where id = $1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  await h.client!.exec(ddlFor(mcpServers as never));
  await h.client!.exec(ddlFor(workspaces as never));
  await h.client!.exec(ddlFor(workspaceMembers as never));
  // Read by the scopedDb visibility predicate (`list` / `listTools`).
  await h.client!.exec(ddlFor(podMembers as never));
  await h.client!.exec(ddlFor(projectMembers as never));
  await h.client!.exec(ddlFor(users as never));
  await h.client!.query(
    `insert into workspaces (id, name, system_slug) values ($1, 'Pod admin', 'pod-admin'), ($2, 'WS', null)`,
    [POD_ADMIN_WS, WS]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       ($1, $4, $5, 'admin'),
       ($2, $6, $7, 'owner'),
       ($3, $6, $8, 'admin'),
       ($9, $6, $10, 'member')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      POD_ADMIN_WS,
      POD_ADMIN,
      WS,
      WS_OWNER,
      WS_ADMIN,
      randomUUID(),
      WS_MEMBER,
    ]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from mcp_servers;`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
});

describe("pod-wide MCP server: non-admins are refused, pod admins succeed", () => {
  // A workspace OWNER is not a pod admin — the strongest non-admin to refuse.
  it.each([NOBODY, WS_OWNER])(
    "setApproved by %s → FORBIDDEN, row stays unapproved",
    async (user) => {
      const id = await seedServer(null);
      await expect(
        caller(user).setApproved({ id, approved: true })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await row(id)).approved).toBe(false);
    }
  );

  it("setApproved by a pod admin → approved", async () => {
    const id = await seedServer(null);
    await caller(POD_ADMIN).setApproved({ id, approved: true });
    expect((await row(id)).approved).toBe(true);
  });

  it("delete by a non-admin → FORBIDDEN, row survives", async () => {
    const id = await seedServer(null, true);
    await expect(caller(NOBODY).delete({ id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await row(id)).toBeDefined();
  });

  it("delete by a pod admin → gone", async () => {
    const id = await seedServer(null, true);
    await caller(POD_ADMIN).delete({ id });
    expect(await row(id)).toBeUndefined();
  });

  it("ping by a non-admin → FORBIDDEN, no IS call, status untouched", async () => {
    const id = await seedServer(null);
    await expect(caller(NOBODY).ping({ id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("unknown");
  });

  it("ping by a pod admin → pinged, status recorded", async () => {
    const id = await seedServer(null);
    await caller(POD_ADMIN).ping({ id });
    expect(fetch).toHaveBeenCalledOnce();
    expect((await row(id)).status).toBe("connected");
  });

  it("update moving a workspace server INTO pod-wide needs pod admin", async () => {
    const id = await seedServer(WS);
    await expect(
      caller(WS_ADMIN).update({ id, workspaceId: null })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ws = await h.client!.query<{ workspace_id: string | null }>(
      `select workspace_id from mcp_servers where id = $1`,
      [id]
    );
    expect(ws.rows[0]!.workspace_id).toBe(WS);
  });
});

describe("workspace MCP server keeps its workspace gate", () => {
  it("approval is owner-only: workspace admin refused, owner succeeds", async () => {
    const id = await seedServer(WS);
    await expect(
      caller(WS_ADMIN).setApproved({ id, approved: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(id)).approved).toBe(false);
    await caller(WS_OWNER).setApproved({ id, approved: true });
    expect((await row(id)).approved).toBe(true);
  });

  it("a non-member cannot delete; a workspace admin can", async () => {
    const id = await seedServer(WS);
    await expect(caller(NOBODY).delete({ id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await caller(WS_ADMIN).delete({ id });
    expect(await row(id)).toBeUndefined();
  });
});

/** A stdio server — the transport that SPAWNS a process on the IS. */
async function seedStdio(
  workspaceId: string | null,
  approved: boolean,
  env: Record<string, string> = {}
) {
  const id = randomUUID();
  await h.client!.query(
    `insert into mcp_servers (id, workspace_id, slug, name, transport, command, env, approved, enabled)
     values ($1, $2, $3, 'S', 'stdio', 'npx', $4, $5, true)`,
    [id, workspaceId, `s-${id.slice(0, 8)}`, JSON.stringify(env), approved]
  );
  return id;
}

describe("stdio servers are never spawned before approval", () => {
  it("ping of an UNapproved stdio server → PRECONDITION_FAILED, no IS call", async () => {
    const id = await seedStdio(WS, false);
    await expect(caller(WS_ADMIN).ping({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/approve this server first/i),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ping of an APPROVED stdio server reaches the IS", async () => {
    const id = await seedStdio(WS, true);
    await caller(WS_ADMIN).ping({ id });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("listTools of an UNapproved stdio server → PRECONDITION_FAILED, no IS call", async () => {
    const id = await seedStdio(WS, false);
    await expect(caller(WS_MEMBER).listTools({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("listTools of an APPROVED stdio server reaches the IS", async () => {
    const id = await seedStdio(WS, true);
    await caller(WS_MEMBER).listTools({ id });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("listTools: a failed read is an error, never 'no tools'", () => {
  it("the IS answering non-2xx → BAD_GATEWAY", async () => {
    const id = await seedStdio(WS, true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 }))
    );
    await expect(caller(WS_MEMBER).listTools({ id })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
    });
  });

  it("the IS unreachable → BAD_GATEWAY", async () => {
    const id = await seedStdio(WS, true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await expect(caller(WS_MEMBER).listTools({ id })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
    });
  });

  it("positive control: a server with no tools reads as an empty list", async () => {
    const id = await seedStdio(WS, true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tools: [] })))
    );
    await expect(caller(WS_MEMBER).listTools({ id })).resolves.toEqual({
      tools: [],
    });
  });
});

describe("list masks env for callers who cannot manage the row", () => {
  const ENV = { API_TOKEN: "sk-live-secret" };
  const envOf = async (user: string, id: string) =>
    (await caller(user).list({ workspaceId: WS })).servers.find(
      (s) => s.id === id
    )?.env;

  it("a plain member sees the keys, never the values", async () => {
    const id = await seedStdio(WS, true, ENV);
    const env = await envOf(WS_MEMBER, id);
    expect(env).toEqual({ API_TOKEN: "••••" });
    expect(JSON.stringify(env)).not.toContain("sk-live-secret");
  });

  it("a workspace admin sees the values", async () => {
    const id = await seedStdio(WS, true, ENV);
    expect(await envOf(WS_ADMIN, id)).toEqual(ENV);
  });

  it("a pod-wide row: a workspace admin is masked, a pod admin is not", async () => {
    const id = await seedStdio(null, true, ENV);
    expect(await envOf(WS_ADMIN, id)).toEqual({ API_TOKEN: "••••" });
    const podAdmin = (
      await caller(POD_ADMIN).list({ workspaceId: null })
    ).servers.find((s) => s.id === id)?.env;
    expect(podAdmin).toEqual(ENV);
  });
});
