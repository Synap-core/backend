/**
 * D13 — an agent changes a kind's scope: `changeKindScope` → proposal →
 * the REAL `profile/change_scope` executor → the REAL `profilesRouter.update`
 * → the REAL `ProfileRepository` / `ProfileResolutionService`, on PGlite.
 *
 * The proof is reachability: a workspace-scoped kind made shared + granted to a
 * THIRD workspace RESOLVES there afterwards (`getBySlugForWorkspace`), and the
 * 60s entity-scope cache — primed with the "not found ⇒ pod" answer before the
 * change — answers the kind's real `entityScope` after it.
 *
 * Stubbed, at infrastructure seams only: `checkPermissionOrPropose` (records
 * the gate call; proposes when an agent forces it — the floor itself is pinned
 * in `@synap/governance-policy` `workspace-ops-floor.test.ts`), audit/split-brain/
 * guest containment. The proposal envelope is built from the RECORDED gate
 * `data`, exactly as `createProposal` nests it (`data.data`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

const { permSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(
    async (_args: Record<string, unknown>) => ({}) as Record<string, unknown>
  ),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: permSpy,
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));
vi.mock("../../access/context.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../access/context.js")>();
  actual.AccessContext.prototype.audience = async () => "member";
  return actual;
});
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "audit-1" })),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ProfileRepository, ProfileResolutionService } from "@synap/database";
import { changeKindScope } from "./change-kind-scope.js";
import { registerProfileExecutors } from "../../routers/proposals/executors/profile.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";
const AGENT = randomUUID();
const HOME = randomUUID();
const THIRD = randomUUID();
const ELSEWHERE = randomUUID();

async function seedKind(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into profiles (id, slug, display_name, scope, workspace_id, entity_scope, profile_kind, is_active, created_at, updated_at)
     values ($1, 'finding', 'Finding', 'workspace', $2, 'workspace', 'kind', true, now(), now())`,
    [id, HOME]
  );
  return id;
}

async function approve(gate: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact("profile/change_scope")!;
  return executor.execute({
    proposal: {
      id: randomUUID(),
      targetId: gate.profileId,
      workspaceId: HOME,
      projectId: null,
      subjectUserId: USER,
      agentUserId: AGENT,
      data: { data: gate },
      targetType: "profile",
      proposalType: "change_scope",
    },
    payload: null,
    userId: USER,
    input: { proposalId: randomUUID() },
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
      emitSideEffects: () => undefined,
      notify: async () => undefined,
    },
  } as never);
}

const resolvesIn = async (workspaceId: string) =>
  (await new ProfileRepository(h.db as never).getBySlugForWorkspace(
    "finding",
    workspaceId
  )) !== null;

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await h.client!.exec(
    "create unique index if not exists pwa_uniq on profile_workspace_access (profile_id, workspace_id);"
  );
  registerProfileExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from profiles; delete from profile_workspace_access; delete from proposals; delete from workspaces; delete from workspace_members; delete from users;"
  );
  await q(
    `insert into users (id, email, user_type) values ($1, 'u@example.test', 'human')`,
    [USER]
  );
  for (const ws of [HOME, THIRD, ELSEWHERE]) {
    await q(
      `insert into workspaces (id, name, owner_id, created_at, updated_at) values ($1, $2, $3, now(), now())`,
      [ws, `ws-${ws.slice(0, 4)}`, USER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
      [ws, USER]
    );
  }
  ProfileResolutionService.invalidateEntityScopeCache();
  permSpy.mockClear();
  permSpy.mockImplementation(async (args) =>
    args.agentUserId && args.forcePropose
      ? {
          granted: false,
          proposalId: randomUUID(),
          proposalType: "change_scope",
        }
      : { granted: true }
  );
});

describe("an agent shares a workspace-scoped kind with a third space", () => {
  it("proposes, and the approval makes the kind resolve there", async () => {
    const profileId = await seedKind();
    expect(await resolvesIn(THIRD)).toBe(false);
    // Prime the 60s cache with the "kind not found here ⇒ pod" answer.
    const resolution = new ProfileResolutionService(h.db as never);
    expect(await resolution.getEntityScope("finding", THIRD)).toBe("pod");

    const res = await changeKindScope(
      { userId: USER, scopes: [], agentUserId: AGENT },
      { profileId, scope: "shared", allowedWorkspaceIds: [THIRD] }
    );
    expect(res.status).toBe("proposed");
    expect(permSpy).toHaveBeenCalledTimes(1);
    const gate = permSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(gate).toMatchObject({
      subjectType: "profile",
      action: "change_scope",
      forcePropose: true,
      agentUserId: AGENT,
      workspaceId: HOME,
    });
    // Nothing changed before approval.
    expect(await resolvesIn(THIRD)).toBe(false);

    const out = await approve(gate.data as Record<string, unknown>);
    expect(out).toMatchObject({ success: true, primaryId: profileId });

    expect(await resolvesIn(THIRD)).toBe(true);
    expect(await resolvesIn(HOME)).toBe(true);
    expect(await resolvesIn(ELSEWHERE)).toBe(false);
    // The cache primed before the change answers the kind's real placement.
    expect(await resolution.getEntityScope("finding", THIRD)).toBe("workspace");
    const [row] = (
      await q<{ scope: string }>(`select scope from profiles where id = $1`, [
        profileId,
      ])
    ).rows;
    expect(row!.scope).toBe("shared");
  });

  it("approval re-runs the owner gate: a non-owner approver changes nothing", async () => {
    const profileId = await seedKind();
    await changeKindScope(
      { userId: USER, scopes: [], agentUserId: AGENT },
      { profileId, entityScope: "pod" }
    );
    const gate = permSpy.mock.calls[0]![0] as Record<string, unknown>;
    // The approver is demoted to a viewer of the kind's home before approving.
    await q(
      `update workspace_members set role = 'viewer' where workspace_id = $1`,
      [HOME]
    );
    await expect(
      approve(gate.data as Record<string, unknown>)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = (
      await q<{ entity_scope: string }>(
        `select entity_scope from profiles where id = $1`,
        [profileId]
      )
    ).rows;
    expect(row!.entity_scope).toBe("workspace");
  });

  it("refuses grants without scope shared, and files nothing for no change", async () => {
    const profileId = await seedKind();
    await expect(
      changeKindScope(
        { userId: USER, scopes: [], agentUserId: AGENT },
        { profileId, allowedWorkspaceIds: [THIRD] }
      )
    ).rejects.toThrow(/scope: "shared"/);
    const same = await changeKindScope(
      { userId: USER, scopes: [], agentUserId: AGENT },
      { profileId, scope: "workspace", entityScope: "workspace" }
    );
    expect(same.status).toBe("unchanged");
    expect(permSpy).not.toHaveBeenCalled();
  });
});
