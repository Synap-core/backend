/**
 * Re-applying a capability that RE-POINTS an approved MCP server demotes it.
 *
 * The defect: the applier's re-apply branch rewrote url/command/args/env/
 * transport on an existing `mcp_servers` row while keeping `approved` ("only
 * promote, never demote"), so a re-applied (or drifted) template could swap
 * what an owner had approved and the IS would keep injecting its tools.
 * `mcpServersRouter.update` already demoted on the same change; both doors now
 * call the ONE rule `execFieldsChanged(MCP_SERVER_RE_APPROVAL_FIELDS, …)`
 * (`skill-exec-fields.ts`). A definition can never approve its own server, and
 * only a server manager for the row's scope may write one at all.
 *
 * Driven through the real `createCapabilityFromDefinition` against a PGlite
 * `mcp_servers` table generated from the Drizzle schema, asserting the ROW.
 * Every other side effect the applier reaches is stubbed exactly as the sibling
 * `create-from-definition.mcp-auth-policy.test.ts` does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

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
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  createPendingProposal: vi.fn(),
}));
vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn(async () => undefined),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
  getLinksFor: vi.fn(async () => []),
  deleteLink: vi.fn(async () => undefined),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({
        capability: { id: "33333333-3333-3333-3333-333333333333" },
      })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
  getSyncGenerationState: async () => ({ generation: 1, isPrimary: true }),
  invalidateSyncGenerationCache: vi.fn(),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk =
      c.primary && type === "uuid"
        ? " primary key default gen_random_uuid()"
        : c.primary
          ? " primary key"
          : "";
    const def =
      c.name === "approved"
        ? " default false"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const UID = "22222222-2222-2222-2222-222222222222";
const WS = "11111111-1111-1111-1111-111111111111";

const SERVER = {
  slug: "remote-tools",
  name: "Remote tools",
  transport: "http",
  url: "https://mcp.example.test/mcp",
};

const WS_ADMIN = "33333333-0000-0000-0000-000000000001";
const WS_MEMBER = "33333333-0000-0000-0000-000000000002";
const POD_ADMIN_WS = "44444444-4444-4444-4444-444444444444";

function apply(
  server: Record<string, unknown>,
  as: { userId: string; workspaceId: string | null } = {
    userId: UID,
    workspaceId: WS,
  }
) {
  return createCapabilityFromDefinition(
    {
      key: "remote-tools",
      name: "Remote tools",
      tools: [],
      skills: [],
      playbooks: [],
      vault: [],
      mcpServers: [server],
    } as never,
    {},
    { ...as, authenticated: true } as never
  );
}
const theRow = async () =>
  (
    await h.client!.query<{ approved: boolean; url: string }>(
      `select approved, url from mcp_servers where slug = $1`,
      [SERVER.slug]
    )
  ).rows;
/** The owner approved it under Settings (the router's setApproved). */
const ownerApproves = () =>
  h.client!.query(`update mcp_servers set approved = true where slug = $1`, [
    SERVER.slug,
  ]);

beforeAll(async () => {
  // The applier also reads/writes the capability container (`capabilities`),
  // so every schema table exists — the assertions only read `mcp_servers`.
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(v));
  }
  expect(seen.has("mcp_servers")).toBe(true);
  // UID owns WS (the happy path below); WS_ADMIN is an admin, WS_MEMBER a plain
  // member. Nobody here is a pod admin of the `pod-admin` system workspace.
  await h.client!.query(
    `insert into workspaces (id, name, system_slug) values ($1, 'WS', null), ($2, 'Pod admin', 'pod-admin')`,
    [WS, POD_ADMIN_WS]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner'),
       (gen_random_uuid(), $1, $3, 'admin'),
       (gen_random_uuid(), $1, $4, 'member')`,
    [WS, UID, WS_ADMIN, WS_MEMBER]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from mcp_servers;`);
});

describe("applier re-apply vs an approved MCP server", () => {
  it("a re-apply with a NEW url demotes the approved server", async () => {
    await apply(SERVER);
    await ownerApproves();
    expect((await theRow())[0]!.approved).toBe(true);

    await apply({ ...SERVER, url: "https://evil.example.test/mcp" });

    const rows = await theRow();
    expect(rows).toHaveLength(1); // re-applied in place, not a second row
    expect(rows[0]).toMatchObject({
      url: "https://evil.example.test/mcp",
      approved: false,
    });
  });

  it("a template `approved: true` does NOT re-approve a re-pointed server", async () => {
    await apply(SERVER);
    await ownerApproves();

    await apply({
      ...SERVER,
      url: "https://evil.example.test/mcp",
      approved: true,
    });

    expect((await theRow())[0]!.approved).toBe(false);
  });

  it("an UNCHANGED re-apply keeps the approval (value, not presence)", async () => {
    await apply(SERVER);
    await ownerApproves();

    await apply({ ...SERVER, name: "Renamed" });

    expect((await theRow())[0]!.approved).toBe(true);
  });
});

describe("who may write an MCP server row through the applier", () => {
  it("a plain workspace MEMBER is refused and no row is written", async () => {
    await expect(
      apply(SERVER, { userId: WS_MEMBER, workspaceId: WS })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await theRow()).toHaveLength(0);
  });

  it("a member cannot overwrite an existing approved row either", async () => {
    await apply(SERVER);
    await ownerApproves();
    await expect(
      apply(
        { ...SERVER, url: "https://evil.example.test/mcp" },
        { userId: WS_MEMBER, workspaceId: WS }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await theRow())[0]).toMatchObject({
      url: SERVER.url,
      approved: true,
    });
  });

  it("a pod-wide row needs a pod admin — a workspace OWNER is refused", async () => {
    await expect(
      apply(SERVER, { userId: UID, workspaceId: null })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await theRow()).toHaveLength(0);
  });

  it("an inline `approved: true` from a workspace ADMIN lands UNapproved", async () => {
    await apply(
      { ...SERVER, approved: true },
      { userId: WS_ADMIN, workspaceId: WS }
    );
    expect(await theRow()).toEqual([
      expect.objectContaining({ approved: false }),
    ]);
  });

  it("a definition's `approved: true` never approves — not even from the owner", async () => {
    await apply({ ...SERVER, approved: true });
    expect((await theRow())[0]!.approved).toBe(false);
    // …nor promotes an existing unapproved row on an unchanged re-apply.
    await apply({ ...SERVER, approved: true });
    expect((await theRow())[0]!.approved).toBe(false);
  });
});
