/**
 * POD HYGIENE on a real Postgres (PGlite) — the retire door, the cleanup-pack
 * scanner, the pack's approval half, and the diagnose section's floors.
 *
 * Real: `proposeProfileRetire` / `applyProfileRetire` (preflight counts over
 * real tables, `ProfileRepository.delete`), `fileCleanupPacks` (every candidate
 * query, `sessionKindWhere`, `classifyProposal`, the open-pack skip), the
 * registered `profile/retire` and `pod_hygiene/cleanup_pack` executors, the
 * expiry write, and `gatherSchemaHygieneSignal` (`userVisibleWhere`,
 * `ownerPrivateVisibleWhere`, `proposalUserFloor`). Tables come from the
 * Drizzle definitions, so every column a query selects exists.
 *
 * Stubbed, and why:
 *  - `insertPendingProposal` — binds @synap/database's own postgres.js client,
 *    which a barrel `db` swap never reaches; stubbed to the same INSERT on
 *    PGlite (status pending + the owner-floor columns the readers key on).
 *  - `assertProfileSchemaWrite` — an authority door with its own suite; the
 *    retire authority is NOT under test here. `isPodAdmin` is a flag the
 *    merge-authority tests flip.
 *  - `completeFocusSession` and `automationsRouter.pause` — the ONE close door
 *    and the ONE pause door have their own suites. What is pinned here is that
 *    the pack reaches them for APPROVED items only, with the owner's identity.
 *  - `runConversions` — the engine has its own suite; pinned: a refusal files
 *    a merge proposal whose suggestion names a real row.
 *  - audit/events/notifications/blob discard — fan-out.
 *
 * NOT covered here: the per-action item CAP (pure, `pod-hygiene-rules.test.ts`),
 * and `proposals.rejectItem` itself — the pack test writes the exact
 * `data.dispositions[ref] = { status: "reject" }` shape that door writes
 * (`routers/proposals.ts` rejectItem) and drives the executor from it.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  closeCalls: [] as Array<{ sessionId: string; userId: string }>,
  pauseCalls: [] as Array<{ id: string; userId: string }>,
  podAdmin: { value: true },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pdb = drizzle(client, {
    schema: {
      proposals: actual.proposals as never,
      profiles: actual.profiles as never,
      automations: actual.automations as never,
      focusSessions: actual.focusSessions as never,
    },
  });
  return {
    ...actual,
    db: pdb,
    insertPendingProposal: async (input: {
      workspaceId: string | null;
      targetType: string;
      targetId: string;
      proposalType: string;
      data: Record<string, unknown>;
      createdBy: string | null;
      proposedByUserId?: string | null;
      subjectUserId?: string | null;
    }) => {
      const id = randomUUID();
      const { rows } = await client.query(
        `insert into proposals (id, status, workspace_id, target_type, target_id, proposal_type, data,
           created_by, proposed_by_user_id, subject_user_id, created_at, updated_at)
         values ($1, 'pending', $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now(), now()) returning *`,
        [
          id,
          input.workspaceId,
          input.targetType,
          input.targetId,
          input.proposalType,
          JSON.stringify(input.data),
          input.createdBy,
          input.proposedByUserId ?? null,
          input.subjectUserId ?? null,
        ]
      );
      return { proposal: { ...(rows[0] as object), id }, deduped: false };
    },
    runConversions: vi.fn(async () => ({
      dryRun: false,
      destructiveTail: false,
      hadError: false,
      results: [
        { opKey: "k", op: "dedupeProfileRows", status: "applied", counts: {} },
      ],
    })),
  };
});
vi.mock(
  "../../../utils/profile-schema-write-access.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    assertProfileSchemaWrite: vi.fn(async () => undefined),
  })
);
vi.mock("../../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async () => h.podAdmin.value),
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => null),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock(
  "../../../notifications/mark-proposal-notifications-actioned.js",
  () => ({ markProposalNotificationsActioned: vi.fn() })
);
vi.mock(
  "../../../utils/store-entity-source-blob.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    discardProposalSourceBlob: vi.fn(async () => undefined),
  })
);
vi.mock("../../focus-sessions/complete-session.js", () => ({
  completeFocusSession: vi.fn(
    async (p: { sessionId: string; userId: string }) => {
      h.closeCalls.push({ sessionId: p.sessionId, userId: p.userId });
      return { session: { id: p.sessionId, status: "closed" } };
    }
  ),
}));
vi.mock("../../../routers/automations.js", () => ({
  automationsRouter: {
    createCaller: (ctx: { userId: string }) => ({
      pause: async ({ id }: { id: string }) => {
        h.pauseCalls.push({ id, userId: ctx.userId });
        return { status: "paused" };
      },
    }),
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  proposals,
  profiles,
  entities,
  entityFacets,
  views,
  automations,
  profileRelations,
  focusSessions,
  users,
  workspaces,
  workspaceMembers,
  relationDefs,
  profileWorkspaceAccess,
  db,
  ProfileRepository,
  readProfileRetirement,
  resolveProfileForApply,
} from "@synap/database";
import {
  proposeProfileRetire,
  inspectProfileRetirement,
  MERGE_NEEDS_POD_ADMIN,
} from "../retire-profile.js";
import { buildProposalChanges } from "../../../routers/proposals/changes.js";
import { fileCleanupPacks } from "../cleanup-pack.js";
import { gatherSchemaHygieneSignal } from "../../diagnose/schema-hygiene.js";
import { registerPodHygieneExecutors } from "../../../routers/proposals/executors/pod-hygiene.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

const A = "user-a";
const B = "user-b";
const AGENT = "agent-1";
const WS_A = randomUUID();
const WS_B = randomUUID();
const NOW = new Date("2026-09-14T00:00:00Z");
const OLD = "2026-07-01T00:00:00Z";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = t.endsWith("[]") && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function kind(p: {
  slug: string;
  scope?: string;
  workspaceId?: string | null;
  createdAt?: string;
  displayName?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into profiles (id, slug, display_name, scope, workspace_id, profile_kind, is_active, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'kind', true, $6, now())`,
    [
      id,
      p.slug,
      p.displayName ?? p.slug,
      p.scope ?? "workspace",
      p.workspaceId === undefined ? WS_A : p.workspaceId,
      p.createdAt ?? OLD,
    ]
  );
  return id;
}

async function entity(
  profileId: string,
  owner = A,
  workspaceId: string | null = WS_A
) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, created_at, updated_at)
     values ($1, $2, $3, $4, 'x', 'x', now(), now())`,
    [randomUUID(), owner, workspaceId, profileId]
  );
}

async function staleSession(owner: string, updatedAt = OLD): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
     values ($1, $2, 'old work', 'stale', '{}'::jsonb, $3, $3)`,
    [id, owner, updatedAt]
  );
  return id;
}

async function neverRunAutomation(
  owner: string,
  workspaceId: string | null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, name, created_by, workspace_id, status, run_count, trigger_config, created_at, updated_at)
     values ($1, 'Generate report', $2, $3, 'active', 0, '{}'::jsonb, $4, now())`,
    [id, owner, workspaceId, OLD]
  );
  return id;
}

async function oldProposal(p: {
  createdBy: string;
  workspaceId: string | null;
  subjectUserId?: string | null;
  agentUserId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, workspace_id, target_type, target_id, proposal_type, data,
       created_by, agent_user_id, subject_user_id, created_at, updated_at)
     values ($1, 'pending', $2, 'entity', $3, 'import.graph', '{}'::jsonb, $4, $5, $6, $7, now())`,
    [
      id,
      p.workspaceId,
      randomUUID(),
      p.createdBy,
      p.agentUserId ?? null,
      p.subjectUserId ?? null,
      OLD,
    ]
  );
  return id;
}

async function status(table: string, id: string) {
  const { rows } = await q<Record<string, unknown>>(
    `select * from ${table} where id = $1`,
    [id]
  );
  return rows[0];
}

function deps() {
  return {
    db: null,
    emitProposalReviewed: vi.fn(),
    reportProposalOutcome: vi.fn(),
    stampProjectMembership: vi.fn(),
    resolveMessagingAccountForPlatform: vi.fn(),
  };
}

async function approve(proposalId: string, approver: string) {
  const [row] = (await q(`select * from proposals where id = $1`, [proposalId]))
    .rows as Array<Record<string, unknown>>;
  const proposal = {
    id: row!.id as string,
    targetType: row!.target_type as string,
    targetId: row!.target_id as string,
    proposalType: row!.proposal_type as string,
    workspaceId: (row!.workspace_id as string | null) ?? null,
    sessionId: null,
    projectId: null,
    agentUserId: (row!.agent_user_id as string | null) ?? null,
    createdBy: row!.created_by as string,
    subjectUserId: (row!.subject_user_id as string | null) ?? null,
    sourceMessageId: null,
    data: row!.data,
  };
  const executor = proposalExecRegistry.resolveExact(
    `${proposal.targetType}/${proposal.proposalType}`
  );
  if (!executor) throw new Error("executor not registered");
  return executor.execute({
    proposal,
    payload: null,
    userId: approver,
    input: { proposalId },
    ctx: {} as never,
    deps: deps() as never,
  });
}

beforeAll(async () => {
  for (const t of [
    proposals,
    profiles,
    entities,
    entityFacets,
    views,
    automations,
    profileRelations,
    focusSessions,
    users,
    workspaces,
    workspaceMembers,
    relationDefs,
    profileWorkspaceAccess,
  ]) {
    await h.client!.exec(ddlFor(t as PgTable));
  }
  registerPodHygieneExecutors();
});

beforeEach(async () => {
  for (const t of [
    "proposals",
    "profiles",
    "entities",
    "entity_facets",
    "views",
    "automations",
    "profile_relations",
    "focus_sessions",
    "users",
    "workspaces",
    "workspace_members",
    "relation_defs",
    "profile_workspace_access",
  ]) {
    await q(`delete from ${t}`);
  }
  h.closeCalls.length = 0;
  h.pauseCalls.length = 0;
  h.podAdmin.value = true;
  await q(
    `insert into workspaces (id, name, owner_id, created_at, updated_at) values ($1, 'A space', $2, now(), now()), ($3, 'B space', $4, now(), now())`,
    [WS_A, A, WS_B, B]
  );
  await q(
    `insert into users (id, user_type) values ($1, 'human'), ($2, 'human'), ($3, 'agent')`,
    [A, B, AGENT]
  );
});

describe("profile retire (D5 / D7)", () => {
  it("REFUSES a kind that still has records and files a merge suggestion naming a real row", async () => {
    const twinSystem = await kind({
      slug: "project",
      scope: "system",
      workspaceId: null,
    });
    const probe = await kind({ slug: "project" });
    await entity(probe);

    const result = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.dependents.entities).toBe(1);
    expect(result.mergeProposalId).not.toBeNull();
    const merge = await status("proposals", result.mergeProposalId!);
    expect(merge).toMatchObject({
      target_type: "profile",
      proposal_type: "merge",
      status: "pending",
    });
    expect(
      (merge!.data as { suggestion: { canonicalProfileId: string } }).suggestion
        .canonicalProfileId
    ).toBe(twinSystem);
    const { rows } = await q(
      `select id from proposals where proposal_type = 'retire'`
    );
    expect(rows).toHaveLength(0);
    expect((await status("profiles", probe))!.is_active).toBe(true);
  });

  it("files a retire for a zero-entity kind, and approval soft-retires it (reversible row kept)", async () => {
    const probe = await kind({ slug: "dogfood-probe-c" });
    const result = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });
    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") return;
    expect((await status("profiles", probe))!.is_active).toBe(true);

    const approved = await approve(result.proposalId, A);

    expect(approved.effect).toMatchObject({
      applied: "verified",
      rows: 1,
      ids: [probe],
    });
    const after = await status("profiles", probe);
    expect(after!.is_active).toBe(false);
    expect((await status("proposals", result.proposalId))!.status).toBe(
      "approved"
    );
  });

  it("re-runs the preflight at approval: a record added after filing refuses the retire", async () => {
    const probe = await kind({ slug: "late-use" });
    const result = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });
    if (result.status !== "proposed") throw new Error("expected proposed");
    await entity(probe, B, WS_B);

    await expect(approve(result.proposalId, A)).rejects.toThrow(
      /Retire refused at approval/
    );
    expect((await status("profiles", probe))!.is_active).toBe(true);
  });

  it("refuses a system row outright", async () => {
    const sys = await kind({
      slug: "task",
      scope: "system",
      workspaceId: null,
    });
    await expect(
      proposeProfileRetire({
        userId: A,
        profileId: sys,
        actingWorkspaceId: WS_A,
      })
    ).rejects.toThrow(/System profiles cannot be retired/);
    expect((await inspectProfileRetirement(sys))!.decision.verdict).toBe(
      "system"
    );
  });
});

describe("cleanup pack (D9)", () => {
  async function seedPod() {
    const sessionA = await staleSession(A);
    const freshA = await staleSession(
      A,
      new Date(NOW.getTime() - 2 * 86_400_000).toISOString()
    );
    const probeA = await kind({ slug: "zero-a" });
    const usedA = await kind({ slug: "used-a" });
    await entity(usedA);
    const autoA = await neverRunAutomation(A, null);
    const propA = await oldProposal({ createdBy: A, workspaceId: WS_A });
    const agentProp = await oldProposal({
      createdBy: AGENT,
      agentUserId: AGENT,
      workspaceId: WS_A,
    });
    const sessionB = await staleSession(B);
    return {
      sessionA,
      freshA,
      probeA,
      usedA,
      autoA,
      propA,
      agentProp,
      sessionB,
    };
  }

  async function packs() {
    return (
      await q<{
        id: string;
        subject_user_id: string;
        data: {
          items: Array<{ ref: string; action: string; targetId: string }>;
        };
      }>(
        `select id, subject_user_id, data from proposals where target_type = 'pod_hygiene' and proposal_type = 'cleanup_pack'`
      )
    ).rows;
  }

  it("files exactly ONE pack per owner, is idempotent on re-run, and applies NOTHING", async () => {
    const s = await seedPod();

    const first = await fileCleanupPacks(NOW);
    expect(first.filed).toBe(2);
    const filed = await packs();
    expect(filed.map((p) => p.subject_user_id).sort()).toEqual([A, B]);

    const packA = filed.find((p) => p.subject_user_id === A)!;
    const targets = packA.data.items
      .map((i) => `${i.action}:${i.targetId}`)
      .sort();
    expect(targets).toEqual(
      [
        `close_session:${s.sessionA}`,
        `retire_profile:${s.probeA}`,
        `pause_automation:${s.autoA}`,
        `expire_proposal:${s.propA}`,
      ].sort()
    );
    // Agent-authored proposal with no subject has no owner; a fresh stale session is too young.
    expect(first.unowned.proposals).toBe(1);

    const second = await fileCleanupPacks(NOW);
    expect(second.filed).toBe(0);
    expect(second.skippedOpenPack).toBe(2);
    expect(await packs()).toHaveLength(2);

    expect((await status("focus_sessions", s.sessionA))!.status).toBe("stale");
    expect((await status("profiles", s.probeA))!.is_active).toBe(true);
    expect((await status("automations", s.autoA))!.status).toBe("active");
    expect((await status("proposals", s.propA))!.status).toBe("pending");
    expect(h.closeCalls).toHaveLength(0);
    expect(h.pauseCalls).toHaveLength(0);
  });

  it("approval applies ONLY the approved items, each through its own door, as the owner", async () => {
    const s = await seedPod();
    const extraSession = await staleSession(A);
    await fileCleanupPacks(NOW);
    const packA = (await packs()).find((p) => p.subject_user_id === A)!;
    const rejectRef = packA.data.items.find(
      (i) => i.targetId === extraSession
    )!.ref;
    const rejectAutoRef = packA.data.items.find(
      (i) => i.targetId === s.autoA
    )!.ref;
    // The exact shape `proposals.rejectItem` persists.
    await q(`update proposals set data = data || $2::jsonb where id = $1`, [
      packA.id,
      JSON.stringify({
        dispositions: {
          [rejectRef]: { status: "reject" },
          [rejectAutoRef]: { status: "reject" },
        },
      }),
    ]);

    const result = await approve(packA.id, A);

    expect(h.closeCalls).toEqual([{ sessionId: s.sessionA, userId: A }]);
    expect(h.pauseCalls).toEqual([]);
    expect((await status("profiles", s.probeA))!.is_active).toBe(false);
    expect((await status("proposals", s.propA))!.status).toBe("expired");
    const pack = await status("proposals", packA.id);
    expect(pack!.status).toBe("approved");
    const outcomes = (
      pack!.data as { outcomes: Array<{ ref: string; outcome: string }> }
    ).outcomes;
    expect(outcomes.find((o) => o.ref === rejectRef)!.outcome).toBe(
      "skipped_by_reviewer"
    );
    expect(outcomes.find((o) => o.ref === rejectAutoRef)!.outcome).toBe(
      "skipped_by_reviewer"
    );
    expect(result.effect).toMatchObject({ applied: "verified", rows: 3 });
  });

  it("a retire item whose kind gained a record since filing is REFUSED, not applied", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    const packA = (await packs()).find((p) => p.subject_user_id === A)!;
    await entity(s.probeA, B, WS_B);

    const result = await approve(packA.id, A);

    expect((await status("profiles", s.probeA))!.is_active).toBe(true);
    expect(
      result.refusals?.some((r) => /Retire refused at approval/.test(r))
    ).toBe(true);
  });
});

describe("diagnose schema hygiene — every number is the caller's", () => {
  it("counts only rows the caller can see or owns", async () => {
    await kind({ slug: "zero-a" });
    await kind({ slug: "zero-b", workspaceId: WS_B });
    await kind({ slug: "task", scope: "system", workspaceId: null });
    const usedElsewhere = await kind({ slug: "used-by-b" });
    await entity(usedElsewhere, B, WS_B);

    await neverRunAutomation(A, null);
    await neverRunAutomation(B, null);
    await neverRunAutomation(B, WS_B);

    await staleSession(A);
    await staleSession(B);

    await oldProposal({ createdBy: A, workspaceId: WS_A });
    await oldProposal({ createdBy: B, workspaceId: WS_B });

    const signal = await gatherSchemaHygieneSignal({
      userId: A,
      workspaceId: null,
      now: NOW,
    });

    expect(signal.zeroEntityKinds.map((k) => k.slug)).toEqual(["zero-a"]);
    expect(signal.neverRunAutomations).toHaveLength(1);
    expect(signal.staleWorkSessions.total).toBe(1);
    expect(signal.oldObjectWorkProposals.total).toBe(1);
  });
});

describe("review card data — what the reviewer actually sees", () => {
  /** The real server seam: stored `data` → the rows the review card renders. */
  function renderedRows(data: Record<string, unknown>) {
    return buildProposalChanges(data, String(data.changeType)).map((c) => ({
      path: c.path,
      after: c.after,
    }));
  }

  it("a retire proposal renders its dependents as rows, with reasoning, not a blank update", async () => {
    const probe = await kind({ slug: "card-probe" });
    const r = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });
    if (r.status !== "proposed") throw new Error("expected proposed");
    const data = (await status("proposals", r.proposalId))!.data as Record<
      string,
      unknown
    >;

    expect(data.changeType).toBe("update");
    expect(typeof data.reasoning).toBe("string");
    expect(data.reason).toBeUndefined();
    const rows = renderedRows(data);
    expect(rows).toContainEqual({
      path: "properties.records_using_it",
      after: 0,
    });
    expect(rows).toContainEqual({
      path: "properties.views_scoped_to_it",
      after: 0,
    });
  });

  it("a merge proposal renders its direction and the pod-admin requirement", async () => {
    await kind({ slug: "project", scope: "system", workspaceId: null });
    const probe = await kind({ slug: "project" });
    await entity(probe);
    const r = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });
    if (r.status !== "refused" || !r.mergeProposalId)
      throw new Error("expected a filed merge");
    const rows = renderedRows(
      (await status("proposals", r.mergeProposalId))!.data as Record<
        string,
        unknown
      >
    );
    expect(rows).toContainEqual({
      path: "properties.collapses_duplicate_rows_of",
      after: "project",
    });
    expect(rows.map((x) => x.path)).toContain(
      "properties.needs_a_pod_admin_to_approve"
    );
  });

  it("a cleanup pack renders one row per action group naming its items, and a vocabulary title", async () => {
    const session = await staleSession(A);
    await q(
      `update focus_sessions set title = 'Dogfood session' where id = $1`,
      [session]
    );
    await neverRunAutomation(A, null);
    await fileCleanupPacks(NOW);
    const [pack] = (
      await q<{ data: Record<string, unknown> }>(
        `select data from proposals where proposal_type = 'cleanup_pack' and subject_user_id = $1`,
        [A]
      )
    ).rows;
    expect(pack!.data.summary).toBe(
      "Tidy your pod: Close 1 idle session, pause 1 automation that never ran"
    );
    const rows = renderedRows(pack!.data);
    expect(rows).toContainEqual({
      path: "properties.Close 1 idle session",
      after: "Dogfood session",
    });
    expect(rows.map((x) => x.path)).toContain("properties.on approve");
  });

  it("a NON-admin is refused a merge at FILING time, with the reason, and nothing is filed", async () => {
    h.podAdmin.value = false;
    await kind({ slug: "project", scope: "system", workspaceId: null });
    const probe = await kind({ slug: "project" });
    await entity(probe);

    const r = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });

    expect(r).toMatchObject({
      status: "refused",
      mergeProposalId: null,
      noMergeReason: MERGE_NEEDS_POD_ADMIN,
    });
    const { rows } = await q(
      `select id from proposals where proposal_type = 'merge'`
    );
    expect(rows).toHaveLength(0);
  });

  it("a merge approved by a NON-admin fails early with the same reason", async () => {
    await kind({ slug: "project", scope: "system", workspaceId: null });
    const probe = await kind({ slug: "project" });
    await entity(probe);
    const r = await proposeProfileRetire({
      userId: A,
      profileId: probe,
      actingWorkspaceId: WS_A,
    });
    if (r.status !== "refused" || !r.mergeProposalId)
      throw new Error("expected a filed merge");
    h.podAdmin.value = false;

    await expect(approve(r.mergeProposalId, B)).rejects.toThrow(
      /only a pod admin/
    );
  });
});

describe("retire tombstone + mergedInto (option A)", () => {
  async function tombstoneOf(profileId: string) {
    const row = await status("profiles", profileId);
    return {
      isActive: row!.is_active as boolean,
      retired: readProfileRetirement({ uiHints: row!.ui_hints } as never),
    };
  }

  async function approvedMerge(
    targetId: string,
    canonicalId: string,
    mergeResult: { status: string } | null
  ) {
    await q(
      `insert into proposals (id, status, workspace_id, target_type, target_id, proposal_type, data,
         created_by, reviewed_at, created_at, updated_at)
       values ($1, 'approved', $2, 'profile', $3, 'merge', $4::jsonb, $5, now(), now(), now())`,
      [
        randomUUID(),
        WS_A,
        targetId,
        JSON.stringify({
          suggestion: {
            op: "dedupeProfileRows",
            slug: "k",
            canonical: "earliest",
            canonicalProfileId: canonicalId,
          },
          ...(mergeResult ? { mergeResult } : {}),
        }),
        A,
      ]
    );
  }

  async function retire(profileId: string) {
    const r = await proposeProfileRetire({
      userId: A,
      profileId,
      actingWorkspaceId: WS_A,
    });
    if (r.status !== "proposed")
      throw new Error(`expected proposed, got ${r.status}`);
    await approve(r.proposalId, A);
    return r.proposalId;
  }

  it("plain retire writes the tombstone with this proposal and no mergedInto", async () => {
    const probe = await kind({ slug: "plain" });
    const proposalId = await retire(probe);
    const t = await tombstoneOf(probe);
    expect(t.isActive).toBe(false);
    expect(t.retired).toMatchObject({ byProposalId: proposalId });
    expect(t.retired!.mergedInto).toBeUndefined();
  });

  it("an APPLIED merge stamps mergedInto with the live canonical", async () => {
    const canon = await kind({ slug: "canon" });
    const probe = await kind({ slug: "merged-src" });
    await approvedMerge(probe, canon, { status: "applied" });
    await retire(probe);
    expect((await tombstoneOf(probe)).retired!.mergedInto).toBe(canon);
  });

  it("a SKIPPED ledger result (opKey already applied) also counts as applied", async () => {
    const canon = await kind({ slug: "canon-s" });
    const probe = await kind({ slug: "merged-src-s" });
    await approvedMerge(probe, canon, { status: "skipped" });
    await retire(probe);
    expect((await tombstoneOf(probe)).retired!.mergedInto).toBe(canon);
  });

  it("an approved merge that never APPLIED gives a plain retire", async () => {
    const canon = await kind({ slug: "canon-u" });
    const probe = await kind({ slug: "merged-src-u" });
    await approvedMerge(probe, canon, null);
    await approvedMerge(probe, canon, { status: "noop" });
    const proposalId = await retire(probe);
    const t = await tombstoneOf(probe);
    expect(t.retired).toMatchObject({ byProposalId: proposalId });
    expect(t.retired!.mergedInto).toBeUndefined();
  });

  it("a canonical that is itself retired is NOT stamped, and the proposal says why", async () => {
    const canon = await kind({ slug: "canon-r" });
    await q(
      `update profiles set is_active = false, ui_hints = jsonb_build_object('retired', jsonb_build_object('at', now()::text)) where id = $1`,
      [canon]
    );
    const probe = await kind({ slug: "merged-src-r" });
    await approvedMerge(probe, canon, { status: "applied" });
    const proposalId = await retire(probe);
    expect((await tombstoneOf(probe)).retired!.mergedInto).toBeUndefined();
    const data = (await status("proposals", proposalId))!.data as Record<
      string,
      unknown
    >;
    expect(data.mergedIntoSkipped).toMatch(/no longer an active kind/);
  });

  it("a retired row SURVIVES a template reconcile/apply — reported, never revived", async () => {
    const probe = await kind({ slug: "survivor" });
    await retire(probe);

    const resolution = await resolveProfileForApply(
      new ProfileRepository(db as never),
      {
        slug: "survivor",
        declaredScope: "workspace",
        declaredKind: "kind",
        workspaceId: WS_A,
        actorUserId: A,
      }
    );

    expect(resolution.profile).toBeNull();
    expect(resolution.conflict?.retired).toBeTruthy();
    const t = await tombstoneOf(probe);
    expect(t.isActive).toBe(false);
    expect(t.retired).not.toBeNull();
  });
});
