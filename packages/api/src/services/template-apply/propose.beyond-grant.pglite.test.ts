/**
 * A computer's (agent's) key whose grant leaves out `workspace.update` runs
 * `synap market update --yes`: the template update is filed as a PENDING
 * proposal the person approves, never refused (founder, 2026-11-02, "the CLI
 * files it for my approval") and never applied by the key itself.
 *
 * Driven through the REAL `proposeTemplateApply` → the REAL
 * `checkPermissionOrPropose` (rung 0 = the key's grant, entered with
 * `runWithGrant` + `runWithActingAgent` as the key-auth doors do) → the
 * pending proposal row, on PGlite with every @synap/database table; then the
 * REAL `workspace/update` approve executor as the person.
 *
 * Rows, each ruling out a wrong outcome:
 *  - the AI preset key's template update is ONE pending `workspace/update`
 *    proposal of the space holding the slug, authored by the agent, carrying
 *    and nothing applied yet — rules out the old 403 ("denied") and
 *    "executed directly";
 *  - the same write with no agent on the request stays DENIED — rules out the
 *    exception reaching a person's limited key;
 *  - a fresh install (`workspace.create`) by the same key stays DENIED —
 *    rules out the exception reaching beyond template updates;
 *  - the agent credential cannot approve it (`refuseAgentProposalApprover`);
 *    the person's approval runs the template update and marks it approved.
 *
 * Faked (their own suites pin them): layer-1 reconcile and preflight, layer 2
 * (`applyPackagePostWorkspace`), the catalog resolve, delivery side effects.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    catalog: new Map<string, Record<string, unknown>>(),
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: run a transaction body on the same handle
        // (atomicity is not under test).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
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
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository,
    getCatalogSyncStamps: async () => ({}),
    withAdvisoryLock: async (_k1: string, _k2: string, fn: () => unknown) =>
      fn(),
    pendingTemplateDataChanges: async () => [],
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
    reconcileWorkspaceFromDefinition: async (input: {
      workspaceId: string;
    }) => ({
      workspaceId: input.workspaceId,
      dryRun: false,
      settings: { merged: [] },
      profiles: {
        added: [],
        reused: [],
        promoted: [],
        deferred: [],
        conflicts: [],
      },
      properties: { added: [], conflicts: [] },
      views: { added: [] },
      entityLinks: { added: [] },
    }),
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async (slug: string) => h.catalog.get(slug) ?? null,
}));
vi.mock("../preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: async () => undefined,
}));
vi.mock("../package-apply-post-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyPackagePostWorkspace: async () => ({}),
}));
vi.mock("../../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithGrant,
} from "@synap/database";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../../routers/proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "../../routers/proposals/executors/workspace.js";
import { refuseAgentProposalApprover } from "../../routers/proposals/review-authority.js";
import { proposeTemplateApply, type PackageApplyBody } from "./propose.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const SPACE = randomUUID();
const SLUG = "brand-library";

/** The computer key's grant: the AI preset (it leaves out workspace.update). */
const AI_PRESET = grantOfScope({
  permissions: [
    ...GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
      .permissions,
  ],
});

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const body = (slug: string): PackageApplyBody =>
  ({
    _meta: { slug, version: `${slug}-2` },
    workspaceName: "Brand library",
    profiles: [],
  }) as unknown as PackageApplyBody;

/** As the key-auth doors run a request: the key's grant, then its agent. */
const asKey = <T>(agentUserId: string | undefined, fn: () => Promise<T>) =>
  runWithGrant(AI_PRESET, () => runWithActingAgent(agentUserId, fn));

async function proposalRow(id: string) {
  const { rows } = await q<Record<string, unknown>>(
    `select id, status, agent_user_id, target_type, target_id, proposal_type, workspace_id, data from proposals where id = $1`,
    [id]
  );
  return rows[0];
}

async function spaceSettings() {
  const { rows } = await q<{ settings: Record<string, unknown> }>(
    `select settings from workspaces where id = $1`,
    [SPACE]
  );
  return rows[0]!.settings;
}

let PROPOSAL_ID = "";

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner@x.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
    [AGENT, "computer@x.test", OWNER]
  );
  // The installed space holding the template (no template state yet).
  await q(
    `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,'Brand library',$2,$3,'ready','{}'::jsonb)`,
    [SPACE, OWNER, SLUG]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), SPACE, OWNER]
  );
  const def = body(SLUG);
  h.catalog.set(SLUG, {
    source: "cache",
    version: `${SLUG}-2`,
    dependencies: [],
    packageDefinition: def,
    workspaceDefinition: def,
  });
  proposalExecRegistry._reset();
  registerWorkspaceExecutors();
}, 120_000);

describe("a template update beyond the key's grant is filed for the person's approval", () => {
  it("the AI preset key's update is ONE pending workspace/update proposal of the space holding the slug", async () => {
    const filed = await asKey(AGENT, () =>
      proposeTemplateApply({
        userId: OWNER,
        agentUserId: AGENT,
        body: body(SLUG),
      })
    );
    expect(filed.kind).toBe("proposed");
    PROPOSAL_ID = (filed as { proposalId: string }).proposalId;

    const row = await proposalRow(PROPOSAL_ID);
    expect(row).toMatchObject({
      status: "pending",
      agent_user_id: AGENT,
      target_type: "workspace",
      proposal_type: "update",
    });
    const inner = (row!.data as { data: Record<string, unknown> }).data;
    expect(inner).toMatchObject({
      id: SPACE,
      operation: "template_update",
      source: "packages.apply",
    });
    // Nothing applied yet: no template apply wrote the space's state.
    expect(await spaceSettings()).toEqual({});
  });

  it("with no agent on the request, the same key is still refused", async () => {
    const filed = await asKey(undefined, () =>
      proposeTemplateApply({ userId: OWNER, body: body(SLUG) })
    );
    expect(filed).toEqual({
      kind: "denied",
      reason: expect.stringContaining('"workspace.update"'),
    });
  });

  it("a fresh install (workspace.create) by the same key is still refused", async () => {
    const filed = await asKey(AGENT, () =>
      proposeTemplateApply({
        userId: OWNER,
        agentUserId: AGENT,
        body: body("not-installed-yet"),
      })
    );
    expect(filed).toEqual({
      kind: "denied",
      reason: expect.stringContaining('"workspace.create"'),
    });
  });

  it("the agent credential cannot approve it; the person's approval applies it", async () => {
    expect(() =>
      runWithActingAgent(AGENT, () => refuseAgentProposalApprover({}))
    ).toThrow(/cannot approve proposals/);

    const r = (await proposalRow(PROPOSAL_ID))!;
    const ex = proposalExecRegistry.resolveExact("workspace/update")!;
    await ex.execute({
      proposal: {
        id: r.id,
        targetType: r.target_type,
        targetId: r.target_id,
        proposalType: r.proposal_type,
        workspaceId: r.workspace_id ?? null,
        agentUserId: r.agent_user_id,
        sessionId: null,
        projectId: null,
        sourceMessageId: null,
        data: r.data,
      },
      payload: null,
      userId: OWNER,
      input: { proposalId: PROPOSAL_ID },
      ctx: {},
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);

    expect((await proposalRow(PROPOSAL_ID))!.status).toBe("approved");
    // Still ONE space for the slug: the update re-synced it, minted nothing.
    const { rows } = await q<{ id: string }>(
      `select id from workspaces where package_slug = $1`,
      [SLUG]
    );
    expect(rows.map((s) => s.id)).toEqual([SPACE]);
    // The template apply ran on it (it wrote the space's template state).
    expect(await spaceSettings()).not.toEqual({});
  });
});

// The exception is decided door by door: the template-apply filing, and the
// history import (founder, 2026-11-03). Derived from the source tree (never a
// hand list), so another door that starts turning grant denials into
// proposals goes red here until decided.
describe("only the decided doors ask to propose beyond the grant", () => {
  it("proposeBeyondGrant is set by the template apply and the history import, nowhere else", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(__dirname, "../..");
    const setters: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "node_modules" && name !== "__tests__") walk(p);
        } else if (
          /\.ts$/.test(name) &&
          !/\.test\.ts$/.test(name) &&
          /proposeBeyondGrant\s*:/.test(readFileSync(p, "utf8"))
        )
          setters.push(relative(root, p));
      }
    };
    walk(root);
    expect(setters.sort()).toEqual([
      "routers/hub-protocol/rest/messaging.ts",
      "services/template-apply/propose.ts",
    ]);
  });
});
