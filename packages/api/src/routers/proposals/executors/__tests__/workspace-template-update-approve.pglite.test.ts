/**
 * An AGENT's template update of an installed space, from the apply door's
 * proposal to the approved rows — on PGlite, through the real
 * `POST /packages/apply` door, the real `workspace/update` executor, the real
 * `materializeWorkspaceCore` → idempotent re-hit → `reconcileWorkspaceIfStale`,
 * the real `applyPackagePostWorkspace` and the real `playbooks.create`.
 *
 * The incident (perso pod, 2026-10-12): `synap market update builder-workspace`
 * with an agent key filed `Create Space "Dev"` with a random target, although
 * "Builder" already held the slug. Approving it reconciled layer 1 and STAMPED
 * the new version, but ran layer 2 as the proposing agent, so the template's new
 * playbook (a floored write) was re-filed as a second proposal and never
 * created — while the stamp said the space was current, so every later update
 * reported "up to date". Pinned here:
 *   (1) the proposal is an UPDATE of the space holding the slug, under its real
 *       name, titled through the vocabulary door;
 *   (2) approving it creates the new playbook (as the approver) AND stamps the
 *       new version;
 *   (3) when layer 2 does not land, the version is NOT stamped.
 *
 * Not under test (mocked): layer-1 schema reconcile (`reconcileWorkspaceFromDefinition`
 * — its own suites), the CP catalog resolve (`resolveWorkspaceTemplate`), the
 * dependency resolver and the activator compile. The permission gate is mocked
 * with the one rule that matters here: an AGENT's floored write proposes, a
 * person's applies.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  templates: new Map<string, Record<string, unknown>>(),
  gateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
    // Layer 1 is not under test: report an additive reconcile that wrote nothing.
    reconcileWorkspaceFromDefinition: async () => ({
      profiles: { added: 0 },
      properties: { added: [], conflicts: [] },
      views: { added: 0 },
      entityLinks: { added: 0 },
    }),
    preflightWorkspaceFromDefinition: async () => ({
      dryRun: true,
      ok: true,
      validationErrors: [],
      profiles: {
        create: [],
        reused: [],
        conflicts: [],
        deferred: [],
        scopeConflicts: [],
      },
      entityLinks: { unresolved: [] },
      views: { wouldOrphan: [] },
    }),
    pendingTemplateDataChanges: async () => [],
  };
});
vi.mock(
  "../../../../services/capabilities/resolve-workspace-template.js",
  () => ({
    resolveWorkspaceTemplate: async (slug: string) =>
      h.templates.get(slug) ?? null,
  })
);
vi.mock("../../../../services/package-dependency-resolver.js", () => ({
  resolvePackageDependencies: async () => ({
    installed: [],
    composeRequested: false,
    composeTargetWorkspaceId: undefined,
  }),
}));
vi.mock("../../../../services/preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: vi.fn(),
}));
vi.mock(
  "../../../../services/workspace-creation-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../services/workspace-creation-service.js")
    >()),
    checkOneSpacePerDomain: async () => ({ action: "create" }),
  })
);
// The gate's one rule that matters here: a floored write by an AGENT files a
// proposal (nothing is created); a person's write applies.
vi.mock("../../../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../utils/permission-check.js")
    >();
  return {
    buildProposalSummary: actual.buildProposalSummary,
    checkPermissionOrPropose: vi.fn(
      async (opts: { agentUserId?: string } & Record<string, unknown>) => {
        h.gateCalls.push(opts);
        return opts.agentUserId
          ? { proposalId: randomUUID(), proposalType: "create" }
          : { allowed: true };
      }
    ),
    previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
    proposedMessageFor: vi.fn(() => "proposed"),
  };
});
vi.mock("../../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../../../../services/playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteTableDdl } from "../../../../__tests__/pglite-ddl.js";
import { registerPackagesRoutes } from "../../../hub-protocol/rest/packages.js";
import type {
  HubHono,
  HubVariables,
} from "../../../hub-protocol/rest/_shared.js";
import { buildProposalSummary } from "../../../../utils/permission-check.js";
import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerWorkspaceExecutors } from "../workspace.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const EXISTING = {
  name: "Evaluate Feature",
  goalTemplate: "Evaluate {feature}",
};
const ADDED = {
  name: "Design to implementation",
  goalTemplate: "Take {design} from draft to implemented",
  params: [{ name: "design", type: "entity", label: "UI design" }],
  stages: [{ key: "generate", name: "Generate", category: "planned" }],
};

/** The catalog's current template (v2): the installed one plus an added playbook. */
function templateV2(slug: string, added: Record<string, unknown>) {
  const packageDefinition = {
    _meta: { slug, version: "h-v2" },
    workspaceName: "Dev",
    profiles: [],
    playbooks: [EXISTING, added],
  };
  return {
    version: "h-v2",
    workspaceDefinition: { workspaceName: "Dev", profiles: [] },
    packageDefinition,
  };
}

async function installedSpace(slug: string): Promise<string> {
  const ws = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, package_slug, provisioning_proposal_id, settings)
     values ($1,'Builder',$2,$3,$3,$4::jsonb)`,
    [
      ws,
      OWNER,
      slug,
      JSON.stringify({ packageVersion: "h-v1", provisioningStatus: "active" }),
    ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), ws, OWNER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, metadata, version)
     values ($1,$2,$3,$4,$5,'[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent','{}'::jsonb,1)`,
    [randomUUID(), ws, OWNER, EXISTING.name, EXISTING.goalTemplate]
  );
  return ws;
}

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("agentUserId", AGENT);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerPackagesRoutes(app);
  return app;
}

/**
 * `market update <slug>` as the agent: the door files a proposal. Persist it
 * the way `createProposal` stores a gated write (`{ data: <gate data> }`) and
 * hand back the row the approve executor reads.
 */
async function agentUpdate(slug: string) {
  h.gateCalls.length = 0;
  const res = await buildApp().request("/packages/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(h.templates.get(slug)!.packageDefinition),
  });
  const reply = (await res.json()) as Record<string, unknown>;
  expect(reply.status, JSON.stringify(reply)).toBe("proposed");
  const gate = h.gateCalls.find((c) => c.subjectType === "workspace")!;
  const data = gate.data as Record<string, unknown>;
  const id = randomUUID();
  const row = {
    id,
    targetType: "workspace",
    targetId: String(data.id ?? randomUUID()),
    proposalType: gate.action as string,
    workspaceId: (gate.workspaceId as string | null) ?? null,
    sessionId: null,
    projectId: null,
    agentUserId: AGENT,
    sourceMessageId: null,
    data: { data },
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status)
     values ($1,$2,$3,$4,$5,$6::jsonb,'pending')`,
    [
      id,
      row.workspaceId,
      row.targetType,
      row.targetId,
      row.proposalType,
      JSON.stringify(row.data),
    ]
  );
  return { gate, data, row };
}

async function approve(row: Record<string, unknown>) {
  const ex = proposalExecRegistry.resolveExact(
    `${row.targetType}/${row.proposalType}`
  );
  if (!ex) throw new Error(`no executor for ${row.proposalType}`);
  return ex.execute({
    proposal: row,
    payload: null,
    userId: OWNER,
    input: { proposalId: row.id },
    ctx: {},
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

async function stampOf(ws: string): Promise<unknown> {
  const { rows } = await q<{ settings: Record<string, unknown> }>(
    `select settings from workspaces where id = $1`,
    [ws]
  );
  return rows[0]?.settings?.packageVersion;
}

async function playbookNames(ws: string): Promise<string[]> {
  const { rows } = await q<{ name: string }>(
    `select name from playbooks where workspace_id = $1 and status <> 'archived' order by name`,
    [ws]
  );
  return rows.map((r) => r.name);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into users (id, email, user_type) values ($1, 'a@x.test', 'agent')`,
    [AGENT]
  );
  proposalExecRegistry._reset();
  registerWorkspaceExecutors();
}, 120_000);

describe("an agent's template update of an installed space", () => {
  it("files an UPDATE of the space holding the slug, under its real name — never 'Create Space <template name>'", async () => {
    const slug = "builder-workspace";
    h.templates.set(slug, templateV2(slug, ADDED));
    const ws = await installedSpace(slug);

    const { gate, data, row } = await agentUpdate(slug);

    expect(gate.action).toBe("update");
    expect(row.targetId).toBe(ws);
    expect(data).toMatchObject({
      name: "Builder",
      operation: "template_update",
      existingWorkspaceId: ws,
      source: "packages.apply",
    });
    expect(buildProposalSummary("workspace", "update", data)).toBe(
      'Update Space "Builder" to the latest template'
    );
  });

  it("approving it creates the added playbook AND stamps the new version", async () => {
    const slug = "builder-approve";
    h.templates.set(slug, templateV2(slug, ADDED));
    const ws = await installedSpace(slug);
    const { row } = await agentUpdate(slug);
    h.gateCalls.length = 0;

    const result = (await approve(row)) as unknown as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, primaryId: ws });
    // The approver approved the package, the new playbook included: it is
    // created, not re-filed as a second proposal.
    expect(await playbookNames(ws)).toEqual([
      "Design to implementation",
      "Evaluate Feature",
    ]);
    expect(
      h.gateCalls.filter((c) => c.subjectType === "playbook" && c.agentUserId)
    ).toEqual([]);
    expect(await stampOf(ws)).toBe("h-v2");
    expect(result.versionStamped).toBe(true);
    // The agent is still enrolled, so its follow-on writes don't become joins.
    const { rows } = await q<{ role: string }>(
      `select role from workspace_members where workspace_id = $1 and user_id = $2`,
      [ws, AGENT]
    );
    expect(rows).toHaveLength(1);
  });

  it("when the post-workspace layer does not land, the new version is NOT stamped", async () => {
    const slug = "builder-broken";
    // A playbook `playbooks.create` refuses (its goal names a param it does
    // not declare): layer 2 reports it as an error item, it is not created.
    const { params: _dropped, ...broken } = ADDED;
    void _dropped;
    h.templates.set(slug, templateV2(slug, broken));
    const ws = await installedSpace(slug);
    const { row } = await agentUpdate(slug);

    const result = (await approve(row)) as unknown as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, primaryId: ws });
    expect(await playbookNames(ws)).toEqual(["Evaluate Feature"]);
    // Still the old stamp: the next `market update` sees the drift and retries.
    expect(await stampOf(ws)).toBe("h-v1");
    expect(result.versionStamped).toBe(false);
  });
});
