/**
 * A plan's DOMAIN steps through their REAL doors, on PGlite with every table:
 *
 *   - the space caller → the plain space door (`workspaces.create`): one space
 *     per domain, a retried approval reuses the space it made, a space of that
 *     name that is somebody else's is refused;
 *   - the kind caller → `materializeKindCreate` → `profiles.create`: a kind of
 *     that slug this proposal made is reused, anybody else's is refused;
 *   - plan compensation (`buildPlanCallers().compensate`) NAMES the space, kind
 *     and lifecycle it keeps (no undo for those yet), never a silent keep;
 *   - `submitCaptureGraph`: an agent's plan carrying a domain step is filed for
 *     a person's review even when governance would let the rest auto-apply
 *     (the control: the same graph without it auto-applies).
 *
 * Stubbed, and why: the permission gate (granted: the approver is the
 * authority; governance has its own suites), the agent-governance verdict
 * (`execute`, so only the domain rule can hold the plan), the event spine,
 * audit and side-effect bus, the two proposal writers (plain inserts of the
 * same row), the entity door (a recorder) and the op idempotency link store.
 *
 * What this cannot see: production Postgres constraints (PGlite tables come
 * from the Drizzle definitions).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  created: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("./permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./permission-check.js")>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("./audit-log.js", () => ({
  auditLog: async () => ({ id: randomUUID() }),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("../services/agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/agent-identity-service.js")
  >()),
  getAgentFocusProjectId: vi.fn(async () => null),
}));
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: vi.fn(async () => ({ decision: "execute" })),
}));

async function insertProposal(
  status: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = (input.id as string | undefined) ?? randomUUID();
  await h.client!.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, session_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now())`,
    [
      id,
      status,
      input.proposalType,
      input.targetType,
      input.targetId,
      input.workspaceId ?? null,
      input.agentUserId ?? null,
      input.createdBy ?? input.userId,
      input.sessionId ?? null,
      JSON.stringify(input.data ?? {}),
    ]
  );
  return {
    id,
    data: input.data,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
  };
}
vi.mock("./event-backed-proposal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./event-backed-proposal.js")>()),
  createEventBackedProposal: async (input: Record<string, unknown>) => ({
    proposal: await insertProposal("pending", input),
    requestedEvent: null,
    correlationId: "c",
  }),
  createAutoApprovedProposal: async (input: Record<string, unknown>) => ({
    proposal: await insertProposal("auto_approved", input),
    requestedEvent: null,
    completedEvent: null,
    correlationId: "c",
  }),
}));
vi.mock("./entity-link-idempotency.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./entity-link-idempotency.js")>()),
  makeExternalLinkIdempotency: (
    _db: unknown,
    o: { namespace: string; provider: string }
  ) => ({
    namespace: o.namespace,
    provider: o.provider,
    lookup: async () => null,
    register: async () => undefined,
    relationExists: async () => false,
  }),
}));
vi.mock("../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.created.push(String(input.title));
        return { status: "created", id: randomUUID() };
      },
    }),
  },
}));
vi.mock("../routers/relations.js", () => ({
  relationsRouter: {
    createCaller: () => ({ create: async () => ({ id: randomUUID() }) }),
  },
}));

import { ProfileResolutionService, runWithActingAgent } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { allSchemaTables, pgliteSchemaDdl } from "../__tests__/pglite-ddl.js";
import { buildRuleLoopCallers } from "./rule-loop-callers.js";
import { buildPlanCallers } from "./plan-callers.js";
import type { MaterializeResult } from "./materialize-composite.js";

const { submitCaptureGraph } =
  await import("../services/capture-agent/submit-capture-graph.js");

const HUMAN = randomUUID();
const AGENT = randomUUID();
const STRANGER = randomUUID();
const WS = randomUUID();
const THEIRS = randomUUID();
const PROPOSAL = randomUUID();
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const callers = (proposalId: string | undefined = PROPOSAL) =>
  buildRuleLoopCallers({
    database: h.db as never,
    userId: HUMAN,
    workspaceId: WS,
    auditSource: "test",
    skillAuthor: { agentUserId: AGENT, personApproved: true },
    ...(proposalId ? { sourceProposalId: proposalId } : {}),
  });

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'h@x', 'Human', 'human'), ($2, 'a@x', 'Scout', 'agent'), ($3, 's@x', 'Stranger', 'human')`,
    [HUMAN, AGENT, STRANGER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, archived_at) values ($1, 'Sales', $2, 'team', '{}'::jsonb, null), ($3, 'Their space', $4, 'team', '{}'::jsonb, null)`,
    [WS, HUMAN, THEIRS, STRANGER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $2, $5, 'editor')`,
    [randomUUID(), WS, HUMAN, randomUUID(), AGENT]
  );
}, 120_000);

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof TRPCError ? err.code : String(err);
  }
  return "applied";
};

describe("a plan's space — the plain space door", () => {
  it("creates the space, its approver its owner", async () => {
    const made = await callers().workspaceCaller.create({
      ref: "ws",
      name: "Acquisitions",
    });
    expect(made.linked).toBe(false);
    const { rows } = await q<{ name: string; role: string }>(
      `select w.name, m.role from workspaces w join workspace_members m on m.workspace_id = w.id where w.id = $1 and m.user_id = $2`,
      [made.id, HUMAN]
    );
    expect(rows).toEqual([{ name: "Acquisitions", role: "owner" }]);
  });

  it("a retried approval reuses it: one space per domain", async () => {
    const again = await callers().workspaceCaller.create({
      ref: "ws",
      name: "Acquisitions",
    });
    expect(again.linked).toBe(true);
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from workspaces where lower(name) = 'acquisitions'`
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("a space of that name that is somebody else's is refused, not adopted", async () => {
    expect(
      await refusal(
        callers().workspaceCaller.create({ ref: "ws", name: "Their space" })
      )
    ).toBe("CONFLICT");
  });

  it("is refused outside an approved plan", async () => {
    expect(
      await refusal(
        callers(undefined).workspaceCaller.create({ ref: "ws", name: "Other" })
      )
    ).toBe("PRECONDITION_FAILED");
  });
});

describe("a step naming another space is floored on the approver", () => {
  it("an automation or a cell in a space the approver is not in is refused", async () => {
    expect(
      await refusal(
        callers().automationCaller.create({
          name: "Elsewhere",
          triggerType: "manual",
          flowDefinition: { nodes: [], edges: [] },
          workspaceId: THEIRS,
        })
      )
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        callers().cellCaller.define({
          name: "Elsewhere",
          rendererSource: "export default function C() { return null; }",
          workspaceId: THEIRS,
        })
      )
    ).toBe("FORBIDDEN");
    const { rows } = await q<{ n: number }>(
      `select (select count(*) from automations where workspace_id = $1) + (select count(*) from widget_definitions where workspace_id = $1) as n`,
      [THEIRS]
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("a plan's kind — the profile create door", () => {
  it("creates the kind, owned by the proposal; a retry reuses it", async () => {
    const made = await callers().kindCaller.define({
      ref: "k",
      slug: "acquisition-target",
      displayName: "Acquisition target",
      fields: [],
    });
    expect(made).toMatchObject({ slug: "acquisition-target", linked: false });
    const { rows } = await q<{ owner_id: string }>(
      `select owner_id from profiles where id = $1`,
      [made.id]
    );
    expect(rows[0]!.owner_id).toBe(PROPOSAL);

    const again = await callers().kindCaller.define({
      ref: "k",
      slug: "acquisition-target",
      displayName: "Acquisition target",
      fields: [],
    });
    expect(again).toEqual({ ...made, linked: true });
  });

  it("a kind of that slug another proposal made is refused, not adopted", async () => {
    expect(
      await refusal(
        callers(randomUUID()).kindCaller.define({
          ref: "k",
          slug: "acquisition-target",
          displayName: "Acquisition target",
          fields: [],
        })
      )
    ).toBe("CONFLICT");
  });
});

describe("a plan that is rolled back keeps its domain, and says so", () => {
  it("compensation names the space, kind and lifecycle it keeps", async () => {
    const space = randomUUID();
    const kind = randomUUID();
    const def = randomUUID();
    const applied: MaterializeResult = {
      created: 0,
      linked: 0,
      primaryId: "",
      refToRealId: {},
      entities: [],
      relations: [],
      relationsFailed: [],
      facets: [],
      skills: [],
      automations: [],
      rules: [],
      playbooks: [],
      views: [],
      updates: [],
      projects: [],
      sessions: [],
      links: [],
      documents: [],
      workspaces: [
        { ref: "ws", opIndex: 0, workspaceId: space, linked: false },
        // A space a retry reused was never this run's: not named.
        { ref: "old", opIndex: 1, workspaceId: WS, linked: true },
      ],
      kinds: [
        {
          ref: "k",
          opIndex: 2,
          profileId: kind,
          slug: "k",
          linked: false,
        },
      ],
      lifecycles: [
        { ref: "lc", opIndex: 3, profileId: kind, propertyDefId: def },
      ],
    };
    const report = await buildPlanCallers({
      database: h.db as never,
      userId: HUMAN,
      sessionOwnerUserId: HUMAN,
      workspaceId: WS,
      workspaceRole: "owner",
      entityCaller: { update: async () => ({}) },
      proposal: { id: PROPOSAL, sessionId: null },
    }).compensate(applied);
    expect(
      report.notCompensated.map((r) => `${r.kind}:${r.id}`).sort()
    ).toEqual(
      [`lifecycle:${def}`, `profile:${kind}`, `workspace:${space}`].sort()
    );
  });
});

describe("an agent's plan with a domain step is a person's to review", () => {
  const capture = (withDomain: boolean) =>
    runWithActingAgent(AGENT, () =>
      submitCaptureGraph({
        userId: HUMAN,
        agentUserId: AGENT,
        workspaceId: WS,
        source: "agent",
        summary: withDomain ? "Domain" : "Notes",
        entities: [
          {
            ref: "n",
            profileSlug: "note",
            title: withDomain ? "With a space" : "Plain note",
            properties: {},
          },
        ],
        ...(withDomain
          ? { plan: { workspaces: [{ ref: "ws2", name: "Radar" }] } }
          : {}),
      } as Parameters<typeof submitCaptureGraph>[0])
    );

  it("files it for review, writes nothing; the same graph without it auto-applies", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null as never);
    await q(`delete from proposals`);
    h.created.length = 0;

    await capture(true);
    const held = await q<{ status: string }>(
      `select status from proposals where data::text like '%Radar%'`
    );
    expect(held.rows.map((r) => r.status)).toEqual(["pending"]);
    expect(h.created).toEqual([]);
    const radar = await q<{ n: number }>(
      `select count(*)::int as n from workspaces where name = 'Radar'`
    );
    expect(radar.rows[0]!.n).toBe(0);

    // Control: governance says `execute`, so without the domain step the
    // same agent's graph applies at once.
    await capture(false);
    expect(h.created).toEqual(["Plain note"]);
  });
});
