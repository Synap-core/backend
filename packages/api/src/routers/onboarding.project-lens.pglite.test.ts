/**
 * `onboarding.resolveContext` for a PROJECT-ONLY lens (`lensKind: "project"`),
 * driven through the REAL procedure on PGlite.
 *
 * First-run onboarding is project-first, so a project lens has no workspace to
 * read the space brief / layout / packageVersion from — the project's OWN
 * `settings` carry them and must build the SAME `WorkspaceContext` shape the
 * workspace branch builds. Before the fix `assertLensAccess` returned `null`
 * for a project lens, so `templateVersion` fell to "1" and every settings-
 * derived signal read as absent.
 *
 * Real: the router, `assertLensAccess` (including the project access floor:
 * owner-private OR `project_members` membership), `resolveTemplateVersion`,
 * `readSpaceBrief`, `meaningfulEntityWhere`, `findJourney`.
 * Stubbed: `getDb` → a PGlite drizzle over every table generated from the
 * Drizzle schema, and the read-only guard (`isPodReadOnly` → false).
 *
 * The access half is the security-critical part: another user's project must
 * NOT resolve, and neither its settings nor its existence may leak.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  // The relational query API (`db.query.projects`) needs the tables declared.
  const db = drizzle(client, {
    schema: {
      projects: actual.projects as never,
      onboardingJourneys: actual.onboardingJourneys as never,
    },
  });
  return { ...actual, getDb: async () => db };
});

// podProcedure's read-only guard reads `sync_generation` on the real pool; the
// split-brain state is not what this test is about.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { pgliteSchemaDdl } from "../__tests__/pglite-ddl.js";
import { onboardingRouter } from "./onboarding.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  onboardingRouter.createCaller({ authenticated: true, userId } as never);

const OWNER = "owner-project";
const OTHER = "other-project";

// A project's settings carry the same keys a workspace's settings do: the
// space brief (`onboarding`), the layout, and `packageVersion`.
const PROJECT_SETTINGS = {
  packageVersion: "2",
  layout: { primarySurface: { kind: "app" as const, appId: "crm" } },
  onboarding: {
    purpose: "Run the client engagement",
    goal: "Get the client's data in",
  },
};

async function seedProject(over: {
  id: string;
  userId: string;
  workspaceId?: string | null;
  settings: unknown;
}) {
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, settings)
     values ($1, $2, $3, 'Engagement', 'active', $4::jsonb)`,
    [
      over.id,
      over.userId,
      over.workspaceId ?? null,
      JSON.stringify(over.settings),
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  // Non-vacuity: the scan must actually see the tables this read touches.
  // `schema` re-exports some tables twice — dedupe by name (the DDL has no
  // `if not exists`).
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  expect(byName.size).toBeGreaterThan(50);
  for (const required of [
    "projects",
    "project_members",
    "entities",
    "profiles",
  ])
    expect(byName.has(required)).toBe(true);
  await h.client!.exec(pgliteSchemaDdl([...byName.values()]));
});

describe("onboarding.resolveContext — project lens (real procedure, PGlite)", () => {
  it("resolves the context from the PROJECT's own settings", async () => {
    const projectId = randomUUID();
    await seedProject({
      id: projectId,
      userId: OWNER,
      settings: PROJECT_SETTINGS,
    });

    const context = await caller(OWNER).resolveContext({
      lens: { kind: "project", projectId },
    });

    // The discriminating assertions: both are derived ONLY from the project's
    // settings, which pre-fix stayed unreachable (context was null).
    expect(context.templateVersion).toBe("2");
    expect(context.signals.hasPrimarySurface).toBe(true);
    expect(context.signals.primarySurfaceKind).toBe("app");
    expect(context.signals.hasOnboardingRecipe).toBe(true);
  });

  it("authorizes a project MEMBER (not only the owner)", async () => {
    const projectId = randomUUID();
    // Owned by OTHER, pod-personal — OWNER can see it only through membership.
    await seedProject({
      id: projectId,
      userId: OTHER,
      settings: PROJECT_SETTINGS,
    });
    await q(
      `insert into project_members (id, project_id, user_id, role)
       values ($1, $2, $3, 'viewer')`,
      [randomUUID(), projectId, OWNER]
    );

    const context = await caller(OWNER).resolveContext({
      lens: { kind: "project", projectId },
    });
    expect(context.templateVersion).toBe("2");
  });

  it("does NOT leak another user's project (no ownership, no membership)", async () => {
    const projectId = randomUUID();
    await seedProject({
      id: projectId,
      userId: OWNER,
      settings: PROJECT_SETTINGS,
    });

    await expect(
      caller(OTHER).resolveContext({
        lens: { kind: "project", projectId },
      })
    ).rejects.toThrow("Project not found or inaccessible");
  });
});
