/**
 * `synap_propose_app_from_playbook` — REACHABILITY, end to end on real SQL
 * (PGlite): "build me a UI for this playbook" → ONE pending proposal whose
 * parts are what the playbook and its kind SAY, and which applies, through
 * each part's own door, into the views, the cell and the binding it showed.
 *
 * Driven for a REAL catalog playbook (CRM "Win a deal" over `deal`, its
 * declared lifecycle stored as the def door stores it), through:
 *   the REAL MCP handler → the REAL playbook get door (the caller's floor) →
 *   the REAL lifecycle resolution → the REAL governance preview → the REAL
 *   pending row (read back) → the REAL review projection
 *   (`buildProposalGraph`) → the REAL materializer with the REAL callers
 *   approval wires (`buildRuleLoopCallers`: views.create, defineCell,
 *   setProfileRenderer) → the REAL undo engine (`safeRevert`).
 *
 * Adversarial: a kind with no lifecycle (refused, names
 * `synap_declare_lifecycle`, nothing filed), a playbook in another person's
 * space (not found), a playbook that works no kind (refused), a second run
 * (the same pending proposal), a run after approval (nothing to propose).
 *
 * Not driven: `applyProposalApproval` itself (its composite branch calls the
 * same materializer with the same `buildRuleLoopCallers`; this file calls
 * those two directly), the desktop drawing the views and the cell
 * (NEEDS-DOGFOOD).
 *
 * Stubbed, and why (as `build.create-skill-turn-on.pglite.test.ts`): the
 * receipt-session mint and the agent's declared focus (PGlite's one
 * connection), audit log, side effects, realtime, the tRPC read-only/audit
 * middlewares: not this seam.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    EventRepository: class {
      async append() {
        return { id: randomUUID() };
      }
      async emitCompleted() {}
      async getCorrelatedEvents() {
        return [];
      }
    },
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
      getCorrelatedEvents: async () => [],
    },
    resolveOrCreateAgentProposalSession: async () => null,
  };
});
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/events", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/audit-log.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  auditLog: vi.fn(async () => ({ id: randomUUID() })),
}));
vi.mock("../../../utils/split-brain-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock(
  "../../../services/focus-sessions/ensure-session-channel.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../../../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import { buildStoredConstraints } from "@synap/database";
import {
  isCompositeProposalData,
  type CompositeProposalData,
} from "@synap-core/types/proposals";
import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";
import { buildProposalGraph } from "../../proposals/display.js";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import { buildRuleLoopCallers } from "../../../utils/rule-loop-callers.js";
import { buildMaterializedRecord } from "../../../services/proposals/stamp-materialized.js";
import { creationsPlanFromRecord } from "../../proposals/revert.js";
import { revertTargetsFromPlan } from "../../../services/proposals/revert-creations.js";
import { safeRevert } from "../../../services/reversibility/safe-revert.js";
import {
  DEAL_LIFECYCLE,
  WIN_A_DEAL_ID,
  WIN_A_DEAL_STAGES,
} from "../../../services/playbook-app/__fixtures__/crm-win-a-deal.js";

const USER = randomUUID();
const AGENT = randomUUID();
const OTHER = randomUUID();
const WS = randomUUID();
const WS_OTHER = randomUUID();
const DEAL = randomUUID();
const NOTE = randomUUID();
const DEAL_STAGE_DEF = randomUUID();
const NOTE_PLAYBOOK = randomUUID();
const LOOSE_PLAYBOOK = randomUUID();
const OTHERS_PLAYBOOK = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    const d = c.default as unknown;
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${String(d)}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (c.hasDefault && type.startsWith("timestamp"))
      def = " default now()";
    else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  const uniques = cfg.indexes.flatMap((idx) => {
    const { unique, where, columns, name } = idx.config;
    const names = columns.map((c) => (c as { name?: unknown }).name);
    if (!unique || where || !names.every((n) => typeof n === "string"))
      return [];
    return [
      `create unique index "${name ?? `${cfg.name}_${names.join("_")}_uidx`}" on "${cfg.name}" (${names.map((n) => `"${n}"`).join(", ")});`,
    ];
  });
  return [`create table "${cfg.name}" (${cols.join(", ")});`, ...uniques].join(
    "\n"
  );
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

type Reply = Record<string, unknown> & {
  status?: string;
  reasonCode?: string;
  nextStep?: string;
  proposalId?: string;
  deduped?: boolean;
  parts?: string[];
  alreadyExists?: Array<{ part: string }>;
};

/** The verb as an agent key calls it. */
async function agentCalls(args: Record<string, unknown>): Promise<Reply> {
  const res = await buildHandlers.synap_propose_app_from_playbook!({
    toolName: "synap_propose_app_from_playbook",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.write"],
    agentUserId: AGENT,
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);
  return JSON.parse((res.content?.[0] as { text: string }).text) as Reply;
}

async function uiProposals() {
  const { rows } = await q<{
    id: string;
    status: string;
    workspace_id: string | null;
    agent_user_id: string | null;
    data: CompositeProposalData & Record<string, unknown>;
  }>(
    `select id, status, workspace_id, agent_user_id, data from proposals
      where data->>'graphSource' = 'playbook_app' order by created_at`
  );
  return rows;
}

async function insertPlaybook(o: {
  id: string;
  workspaceId: string | null;
  createdBy: string;
  name: string;
  subjectProfile: unknown;
  stages: unknown;
}) {
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status, subject_profile, stages, params, criteria, expected_outputs, required_intents, guidance, input_strategy, channel_spec, metadata)
     values ($1, $2, $3, $4, 'Work {name}', 'active', $5::jsonb, $6::jsonb, '[]', '[]', '[]', '[]', '[]', '{"kind":"none"}', '{}', '{}')`,
    [
      o.id,
      o.workspaceId,
      o.createdBy,
      o.name,
      JSON.stringify(o.subjectProfile),
      JSON.stringify(o.stages),
    ]
  );
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
  await q(
    `insert into users (id, email, name, user_type, created_by_user_id, agent_type) values
      ($1, 'u@x.test', 'Ada', 'human', null, null),
      ($2, 'a@x.test', 'Scout', 'agent', $1, 'claude-code'),
      ($3, 'o@x.test', 'Bo', 'human', null, null)`,
    [USER, AGENT, OTHER]
  );
  await q(
    `insert into workspaces (id, owner_id, name) values ($1, $2, 'Sales'), ($3, $4, 'Elsewhere')`,
    [WS, USER, WS_OTHER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner')`,
    [randomUUID(), WS, USER, randomUUID(), WS_OTHER, OTHER]
  );
  // `deal`'s lifecycle as the def door stores it: a select def whose options
  // carry their category, linked to the profile as ITS lifecycle.
  await q(
    `insert into property_defs (id, slug, value_type, constraints) values ($1, $2, 'string', $3::jsonb)`,
    [
      DEAL_STAGE_DEF,
      DEAL_LIFECYCLE.property,
      JSON.stringify(
        buildStoredConstraints({
          enumOptions: DEAL_LIFECYCLE.options.map((o) => ({ ...o })),
        })
      ),
    ]
  );
  await q(
    `insert into profiles (id, slug, display_name, plural, profile_kind, entity_scope, scope) values
      ($1, 'deal', 'Deal', 'Deals', 'kind', 'workspace', 'system'),
      ($2, 'note', 'Note', null, 'kind', 'workspace', 'system')`,
    [DEAL, NOTE]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [DEAL, DEAL_STAGE_DEF]
  );
  await insertPlaybook({
    id: WIN_A_DEAL_ID,
    workspaceId: WS,
    createdBy: USER,
    name: "Win a deal",
    subjectProfile: { profileSlug: "deal" },
    stages: WIN_A_DEAL_STAGES,
  });
  await insertPlaybook({
    id: NOTE_PLAYBOOK,
    workspaceId: WS,
    createdBy: USER,
    name: "Tidy notes",
    subjectProfile: { profileSlug: "note" },
    stages: [{ key: "tidy", name: "Tidy" }],
  });
  await insertPlaybook({
    id: LOOSE_PLAYBOOK,
    workspaceId: WS,
    createdBy: USER,
    name: "Weekly review",
    subjectProfile: null,
    stages: [{ key: "review", name: "Review" }],
  });
  await insertPlaybook({
    id: OTHERS_PLAYBOOK,
    workspaceId: WS_OTHER,
    createdBy: OTHER,
    name: "Bo's deals",
    subjectProfile: { profileSlug: "deal" },
    stages: WIN_A_DEAL_STAGES,
  });
});

describe("synap_propose_app_from_playbook — refused with the next step, nothing filed", () => {
  it("a kind with no declared lifecycle names synap_declare_lifecycle", async () => {
    const reply = await agentCalls({ playbookId: NOTE_PLAYBOOK });
    expect(reply).toMatchObject({
      status: "refused",
      reasonCode: "KIND_HAS_NO_LIFECYCLE",
    });
    expect(reply.nextStep).toContain("synap_declare_lifecycle");
    expect(reply.nextStep).toContain(NOTE);
    expect(await uiProposals()).toHaveLength(0);
  });

  it("a playbook that works no kind says so", async () => {
    const reply = await agentCalls({ playbookId: LOOSE_PLAYBOOK });
    expect(reply).toMatchObject({
      status: "refused",
      reasonCode: "PLAYBOOK_WORKS_NO_KIND",
    });
    expect(reply.nextStep).toContain("synap_update_playbook");
    expect(await uiProposals()).toHaveLength(0);
  });

  it("another person's playbook, in a space this caller is not in, is not found", async () => {
    const reply = await agentCalls({ playbookId: OTHERS_PLAYBOOK });
    expect(reply).toMatchObject({
      status: "refused",
      reasonCode: "PLAYBOOK_NOT_FOUND",
    });
    expect(await uiProposals()).toHaveLength(0);
  });
});

describe("synap_propose_app_from_playbook — one proposal from the facts, applied through each door", () => {
  let proposalId = "";

  it("files ONE pending proposal whose parts are what the playbook and its kind say", async () => {
    const reply = await agentCalls({
      playbookId: WIN_A_DEAL_ID,
      reasoning: "Ada asked for an app for her deal pipeline",
    });
    expect(reply).toMatchObject({
      status: "proposed",
      deduped: false,
      parts: ["pipeline", "bento", "cell", "binding"],
    });
    proposalId = reply.proposalId as string;

    const rows = await uiProposals();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      id: proposalId,
      status: "pending",
      workspace_id: WS,
      agent_user_id: AGENT,
    });
    expect(isCompositeProposalData(row.data)).toBe(true);
    const ops = row.data.operations;
    const pipeline = ops.find(
      (o) => o.op === "create_view" && o.viewType === "pipeline"
    );
    const bento = ops.find(
      (o) => o.op === "create_view" && o.viewType === "bento"
    );
    const cell = ops.find((o) => o.op === "create_cell");
    const binding = ops.find((o) => o.op === "bind_renderer");
    expect(pipeline).toMatchObject({ config: { profileSlug: "deal" } });
    expect(bento).toBeDefined();
    expect((cell as { rendererSource: string }).rendererSource).toContain(
      `"flow.of"`
    );
    expect(binding).toMatchObject({
      target: { kind: "playbook", id: WIN_A_DEAL_ID },
      slot: "detail",
      cellRef: (cell as { ref: string }).ref,
    });

    // What the reviewer sees: every part drawn, the binding under its cell.
    const graph = buildProposalGraph(row.data);
    expect(graph.views?.map((v) => v.viewType)).toEqual(["pipeline", "bento"]);
    expect(graph.views?.[0]?.lifecycleOf).toBe("deal");
    expect(graph.views?.[1]?.widgets?.length).toBeGreaterThan(0);
    expect(graph.cells).toHaveLength(1);
    expect(graph.cells?.[0]).toMatchObject({
      mechanism: "module",
      bindings: [
        { targetKind: "playbook", targetId: WIN_A_DEAL_ID, slot: "detail" },
      ],
    });
  });

  it("a second run returns the same pending proposal, never a second one", async () => {
    const again = await agentCalls({ playbookId: WIN_A_DEAL_ID });
    // `duplicate`: every governed-write door's word for "the same proposal is
    // already pending" (`shared.ts`), with the stop-re-proposing hint.
    expect(again).toMatchObject({
      status: "duplicate",
      proposalId,
      deduped: true,
      changedSincePending: false,
    });
    expect(await uiProposals()).toHaveLength(1);
  });

  it("approved, each part lands through its own door; a run after it proposes nothing; undo retires them", async () => {
    const [row] = await uiProposals();
    const fail = {
      create: async () => {
        throw new Error("this bundle carries no entity or relation");
      },
    };
    const result = await materializeCompositeGraph(
      row!.data.operations,
      fail,
      fail,
      undefined,
      {
        ...buildRuleLoopCallers({
          database: h.db as never,
          userId: USER,
          workspaceId: WS,
          auditSource: "rule_loop_approval",
          skillAuthor: { agentUserId: AGENT, personApproved: true },
          sourceProposalId: row!.id,
        }),
      }
    );
    expect(result.views).toHaveLength(2);
    expect(result.cells).toHaveLength(1);
    expect(result.cells?.[0]?.created).toBe(true);
    expect(result.renderers).toHaveLength(1);

    const { rows: views } = await q<{ type: string; config: unknown }>(
      `select type, config from views where workspace_id = $1 order by type`,
      [WS]
    );
    expect(views.map((v) => v.type)).toEqual(["bento", "pipeline"]);
    const { rows: cells } = await q<{
      type_key: string;
      renderer_source: string;
    }>(
      `select type_key, renderer_source from widget_definitions where workspace_id = $1`,
      [WS]
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.renderer_source).toContain(`"flow.of"`);
    const { rows: bindings } = await q<{
      subject_kind: string;
      subject_id: string;
      ref: { cellKey?: string };
      revoked_at: string | null;
      source_proposal_id: string | null;
    }>(
      `select subject_kind, subject_id, ref, revoked_at, source_proposal_id from renderer_bindings`
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      subject_kind: "playbook",
      subject_id: WIN_A_DEAL_ID,
      revoked_at: null,
      source_proposal_id: row!.id,
    });
    expect(bindings[0]!.ref.cellKey).toBe(cells[0]!.type_key);

    // Everything exists now: the verb says so and files nothing.
    await q(`update proposals set status = 'approved' where id = $1`, [
      row!.id,
    ]);
    const after = await agentCalls({ playbookId: WIN_A_DEAL_ID });
    expect(after.status).toBe("exists");
    expect(after.alreadyExists?.map((e) => e.part)).toEqual([
      "pipeline",
      "bento",
      "cell",
      "binding",
    ]);
    expect(await uiProposals()).toHaveLength(1);

    // Undo: the binding revoked, the cell and both views retired.
    const plan = creationsPlanFromRecord(buildMaterializedRecord(result));
    const undone = await safeRevert({
      targets: revertTargetsFromPlan(plan),
      mode: "skip_touched",
      touchedSince: null,
      sourceProposalId: row!.id,
    });
    expect(undone.skipped).toEqual([]);
    expect(undone.reverted.map((t) => t.kind).sort()).toEqual([
      "cell",
      "renderer_binding",
      "view",
      "view",
    ]);
    expect(
      (await q(`select id from views where workspace_id = $1`, [WS])).rows
    ).toHaveLength(0);
    expect(
      (
        await q(`select id from widget_definitions where workspace_id = $1`, [
          WS,
        ])
      ).rows
    ).toHaveLength(0);
    expect(
      (await q(`select id from renderer_bindings where revoked_at is null`))
        .rows
    ).toHaveLength(0);
  });
});
