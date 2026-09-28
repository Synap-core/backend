/**
 * A workspace DESCRIPTION written through `workspaces.update` actually lands.
 *
 * It did not: the procedure accepted `description`, forwarded it to the
 * permission gate and the audit log, then called
 * `workspaceRepo.update(id, { name, settings })` — and `UpdateWorkspaceInput`
 * had no `description`, so `.set()` never wrote it. Every door that re-describes
 * a space rides this one procedure — `synap_update_workspace`
 * (`renameWorkspaceDoor`), Hub `PATCH /workspaces/:id`, and the approval replay
 * in `proposals/executors/workspace.ts` — so all three answered "updated" and
 * changed nothing. The space brief reads this column as the space's purpose.
 *
 * Driven through the REAL procedure → REAL `WorkspaceRepository.update` → REAL
 * SQL on PGlite. Stubbed: the permission gate (granted — governance has its own
 * tests), the event append and side-effect bus (not what this proves).
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { workspaces, syncGeneration } from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";
const WS = randomUUID();

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

const descriptionOf = async () =>
  (
    await h.client!.query<{ description: string | null; name: string }>(
      `select description, name from workspaces where id = $1`,
      [WS]
    )
  ).rows[0];

const caller = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

beforeAll(async () => {
  // `syncGeneration`: the mutation middleware's replica guard reads it (an
  // empty table = this pod is not a read-only replica).
  for (const t of [workspaces, syncGeneration])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, description, settings, created_at, updated_at)
     values ($1, 'Brand Library', $2, 'Old purpose.', '{}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
});

describe("workspaces.update — description persists", () => {
  it("a description-only update writes the column", async () => {
    const res = await caller().update({
      id: WS,
      description: "Reusable source of truth for brand identity.",
    });
    expect(res.status).toBe("updated");
    expect(await descriptionOf()).toEqual({
      description: "Reusable source of truth for brand identity.",
      name: "Brand Library",
    });
  });

  it("a rename without a description leaves the description untouched", async () => {
    await caller().update({ id: WS, name: "Brand" });
    expect(await descriptionOf()).toEqual({
      description: "Reusable source of truth for brand identity.",
      name: "Brand",
    });
  });

  it("an empty description clears it", async () => {
    await caller().update({ id: WS, description: "   " });
    expect((await descriptionOf())?.description).toBeNull();
  });
});
