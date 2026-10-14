/**
 * `workspaces.create` reads only what it STORES (W3; found by W1).
 *
 * The template identity (`packageSlug`) is server-owned: `create` strips it
 * from the stored blob, and a template is installed only through the ONE
 * template apply (`createFromDefinition` / `installFromCatalog` / the Hub
 * apply). Before, `create` still READ the client's `settings.packageSlug`: it
 * refused the name as a template-identity clash (409), tier-checked it, and
 * told `workspace-init` the space had a template (which skips the default
 * views) — then stored a space with no template at all.
 *
 * Driven through the REAL procedure → REAL `assertWorkspaceIdentityFree` →
 * REAL `WorkspaceRepository.create` → PGlite. Stubbed: the permission gate
 * (granted), the tier gate (recorded), the job queue (recorded), the event
 * append and side-effect bus, audit.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  jobs: [] as Array<{ name: string; data: Record<string, unknown> }>,
  tierChecks: [] as string[],
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
vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: async (_userId: string, slug: string) => {
    h.tierChecks.push(slug);
  },
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
  getBoss: () => ({
    send: async (name: string, data: Record<string, unknown>) => {
      h.jobs.push({ name, data });
    },
  }),
}));

import type { PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  syncGeneration,
} from "@synap/database/schema";
import { pgliteTableDdl } from "../__tests__/pglite-ddl.js";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";

const caller = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
  } as never);

beforeAll(async () => {
  for (const t of [workspaces, workspaceMembers, syncGeneration])
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
  // The CRM template is installed on this pod, in another space.
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, package_slug, settings, created_at, updated_at)
     values ($1, 'Sales', 'someone-else', 'crm', '{"packageSlug":"crm"}'::jsonb, now(), now())`,
    [randomUUID()]
  );
});

describe("workspaces.create — a settings blob never carries a template identity", () => {
  it("a client packageSlug is neither stored, nor identity-checked, nor tier-checked, nor told to workspace-init", async () => {
    const res = (await caller().create({
      name: "My notes",
      settings: { packageSlug: "crm", templateName: "Notes" },
    })) as { status: string; workspaceId: string };
    expect(res.status).toBe("created");

    const { rows } = await h.client!.query<{
      package_slug: string | null;
      settings: Record<string, unknown>;
    }>(`select package_slug, settings from workspaces where id = $1`, [
      res.workspaceId,
    ]);
    expect(rows[0]!.package_slug).toBeNull();
    expect(rows[0]!.settings.packageSlug).toBeUndefined();
    expect(h.tierChecks).toEqual([]);

    const init = h.jobs.find((j) => j.name === "workspace-init");
    expect(init?.data).toMatchObject({
      workspaceId: res.workspaceId,
      templateName: "Notes",
    });
    expect(init?.data.packageSlug).toBeUndefined();
  });

  it("the name is still the identity: a taken name is a typed 409", async () => {
    await expect(caller().create({ name: "Sales" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
