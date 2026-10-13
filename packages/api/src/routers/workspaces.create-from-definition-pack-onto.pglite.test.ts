/**
 * A PACK added to an existing space keeps the space's identity and lands in
 * its pack ledger (W0, APPLY-ONE-DOOR-PLAN — found while fixing defect A/B).
 *
 * The Marketplace "Add to workspace" (and the profile-pack browser) install a
 * pack through `createFromDefinition({ definition, workspaceId, packageSlug,
 * packageVersion })`. That lands in the fresh-create branch with
 * `resumeFrom: { workspaceId }`, and the create util wrote the PACK's slug as
 * the target's `settings.packageSlug` (+ the `package_slug` column) and handed
 * the pack's version back as the target's `pendingVersionStamp` — the CRM
 * space became "the view pack, at the view pack's version". Nothing recorded
 * the pack in `installedPacks`; the browser filed that receipt itself, which a
 * settings save can no longer do (server-owned).
 *
 * Driven through the REAL procedure → REAL finisher → REAL
 * `recordInstalledPack` / `WorkspaceRepository` → PGlite. The create util is a
 * stand-in that does exactly what the real one does with identity
 * (`create-workspace-from-definition.ts`: `settings.packageSlug = packageSlug`
 * merged on resume, `pendingVersionStamp = packageVersion`), so the assertion
 * is on what this door hands it. Stubbed: extends resolution, side-effect bus,
 * audit, realtime, the job queue.
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
  const actual = await importOriginal<typeof import("@synap/database")>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  const events = { append: async () => undefined };
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: events,
    // The identity behaviour of the real util, nothing else.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      packageSlug?: string;
      packageVersion?: string;
      resumeFrom?: { workspaceId: string };
    }) => {
      const workspaceId = input.resumeFrom!.workspaceId;
      if (input.packageSlug) {
        await new actual.WorkspaceRepository(db, events as never).mergeSettings(
          workspaceId,
          { packageSlug: input.packageSlug },
          input.userId
        );
      }
      return {
        workspaceId,
        profileIds: [],
        viewIds: [],
        entityIds: [],
        ...(input.packageVersion
          ? { pendingVersionStamp: input.packageVersion }
          : {}),
      };
    },
  };
});
vi.mock("../services/workspace-composition.js", () => ({
  resolveWorkspaceExtends: async (definition: unknown) => ({
    definition,
    provenance: [],
  }),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  syncGeneration,
} from "@synap/database/schema";
import { router } from "../trpc.js";
import { definitionEngineProcedures } from "./workspaces/definition-engine.js";

const OWNER = "owner-1";

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

const testRouter = router({
  createFromDefinition: definitionEngineProcedures.createFromDefinition,
});
const caller = () =>
  testRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
  } as never);

async function seedSpace(settings: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, package_slug, created_at, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, now(), now())`,
    [
      id,
      `Space ${id.slice(0, 6)}`,
      OWNER,
      JSON.stringify(settings),
      (settings.packageSlug as string | undefined) ?? null,
    ]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), id, OWNER]
  );
  return id;
}

const rowOf = async (id: string) =>
  (
    await h.client!.query<{
      settings: Record<string, unknown>;
      package_slug: string | null;
    }>(`select settings, package_slug from workspaces where id = $1`, [id])
  ).rows[0]!;

beforeAll(async () => {
  for (const t of [workspaces, workspaceMembers, syncGeneration])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
});

describe("createFromDefinition — a pack added to an existing space", () => {
  it("keeps the space's packageSlug / packageVersion and records the pack", async () => {
    const ws = await seedSpace({
      packageSlug: "crm",
      packageVersion: "2.3.0",
      provisioningStatus: "active",
    });

    await caller().createFromDefinition({
      definition: { views: [] } as never,
      workspaceId: ws,
      packageSlug: "pipeline-views",
      packageVersion: "1.4.0",
    });

    const row = await rowOf(ws);
    expect(row.package_slug).toBe("crm");
    expect(row.settings.packageSlug).toBe("crm");
    expect(row.settings.packageVersion).toBe("2.3.0");
    const packs = row.settings.installedPacks as Array<{
      slug: string;
      version: string;
    }>;
    // Recorded; its version written by the finisher on convergence.
    expect(packs.map((p) => [p.slug, p.version])).toEqual([
      ["pipeline-views", "1.4.0"],
    ]);
  });

  it("an UNIDENTIFIED target still takes the slug as its identity (chat-first)", async () => {
    const ws = await seedSpace({});
    await caller().createFromDefinition({
      definition: { views: [] } as never,
      workspaceId: ws,
      packageSlug: "content-os",
      packageVersion: "0.9.0",
    });
    const row = await rowOf(ws);
    expect(row.settings.packageSlug).toBe("content-os");
    expect(row.settings.packageVersion).toBe("0.9.0");
    expect(row.settings.installedPacks).toBeUndefined();
  });
});
