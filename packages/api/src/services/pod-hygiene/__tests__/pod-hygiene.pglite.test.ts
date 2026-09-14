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
  /** Runs before the stubbed close; a throw here is a door failure. */
  beforeClose: null as null | ((sessionId: string) => Promise<void>),
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
      if (h.beforeClose) await h.beforeClose(p.sessionId);
      h.closeCalls.push({ sessionId: p.sessionId, userId: p.userId });
      // The real door's effect, so a rescan sees a closed session as closed.
      await h.client!.query(
        `update focus_sessions set status = 'closed', updated_at = now() where id = $1`,
        [p.sessionId]
      );
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
import { stableItemRef } from "@synap-core/types/pod-hygiene";
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
  h.beforeClose = null;
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

describe("cleanup pack v2 (filer + executor)", () => {
  type PackDbRow = {
    id: string;
    status: string;
    subject_user_id: string;
    reviewed_at: string | null;
    data: Record<string, any>;
  };
  async function packs(owner: string): Promise<PackDbRow[]> {
    return (
      await q<PackDbRow>(
        `select id, status, subject_user_id, reviewed_at, data from proposals
         where target_type = 'pod_hygiene' and proposal_type = 'cleanup_pack' and subject_user_id = $1
         order by created_at`,
        [owner]
      )
    ).rows;
  }
  const latest = async (owner: string) => (await packs(owner)).at(-1)!;
  const refsOf = (p: PackDbRow) =>
    (p.data.items as Array<{ ref: string }>).map((i) => i.ref).sort();
  const S = (id: string) => stableItemRef("close_session", id);
  const K = (id: string) => stableItemRef("retire_profile", id);

  async function seedPod() {
    const sessionA = await staleSession(A);
    await q(`update focus_sessions set title = 'Weekly sync' where id = $1`, [
      sessionA,
    ]);
    const probeA = await kind({ slug: "zero-a", displayName: "Zero A" });
    const usedA = await kind({ slug: "used-a" });
    await entity(usedA);
    const autoA = await neverRunAutomation(A, null);
    const propA = await oldProposal({ createdBy: A, workspaceId: WS_A });
    const sessionB = await staleSession(B);
    return { sessionA, probeA, usedA, autoA, propA, sessionB };
  }

  async function setData(packId: string, patch: Record<string, unknown>) {
    await q(`update proposals set data = data || $2::jsonb where id = $1`, [
      packId,
      JSON.stringify(patch),
    ]);
  }

  it("files a schema-2 pack: id-keyed refs, evidence, no expire/pause items, no changeType/properties — and applies NOTHING", async () => {
    const s = await seedPod();

    const result = await fileCleanupPacks(NOW);

    expect(result.filed).toBe(2);
    const packA = await latest(A);
    expect(packA.data.schema).toBe(2);
    expect(refsOf(packA)).toEqual([S(s.sessionA), K(s.probeA)].sort());
    expect(packA.data.changeType).toBeUndefined();
    expect(packA.data.properties).toBeUndefined();
    const kindItem = packA.data.items.find((i: any) => i.ref === K(s.probeA));
    expect(kindItem.evidence).toMatchObject({
      records: 0,
      dependents: { views: 0 },
    });
    expect(kindItem.subject).toEqual({
      kind: "kind",
      id: s.probeA,
      name: "Zero A",
    });
    const sessionItem = packA.data.items.find(
      (i: any) => i.ref === S(s.sessionA)
    );
    expect(sessionItem.snapshot.updatedAt).toBe(new Date(OLD).toISOString());

    expect((await status("focus_sessions", s.sessionA))!.status).toBe("stale");
    expect((await status("profiles", s.probeA))!.is_active).toBe(true);
    expect((await status("automations", s.autoA))!.status).toBe("active");
    expect((await status("proposals", s.propA))!.status).toBe("pending");
    expect(h.closeCalls).toHaveLength(0);
  });

  it("a kind the retire preflight would refuse is NOT packed, and is counted", async () => {
    const scoped = await kind({ slug: "zero-but-viewed" });
    await q(
      `insert into views (id, scope_profile_ids) values ($1, ARRAY[$2]::uuid[])`,
      [randomUUID(), scoped]
    );
    const plain = await kind({ slug: "zero-plain" });

    const result = await fileCleanupPacks(NOW);

    expect(refsOf(await latest(A))).toEqual([K(plain)]);
    expect(result.notPacked.refusedByPreflight).toBe(1);
  });

  it("an open pack suppresses its items: an immediate re-scan files nothing", async () => {
    await seedPod();
    await fileCleanupPacks(NOW);

    const second = await fileCleanupPacks(NOW);

    expect(second.filed).toBe(0);
    expect(second.suppressed.open).toBe(3);
    expect(await packs(A)).toHaveLength(1);
  });

  it("Leave out is remembered: a decided pack's left-out item is not proposed again", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    const first = await latest(A);
    await setData(first.id, {
      dispositions: { [K(s.probeA)]: { status: "reject" } },
    });
    await approve(first.id, A);
    const later = await staleSession(A);

    const rescan = await fileCleanupPacks(NOW);

    expect(refsOf(await latest(A))).toEqual([S(later)]);
    expect(rescan.suppressed.kept).toBe(1);
  });

  it("an expired or withdrawn pack buys no silence — its items are proposed again", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    await q(`update proposals set status = 'expired' where id = $1`, [
      (await latest(A)).id,
    ]);

    await fileCleanupPacks(NOW);
    const refiled = await latest(A);
    expect(refsOf(refiled)).toEqual([S(s.sessionA), K(s.probeA)].sort());

    // A manual withdraw stamps reviewedAt — still not a decision.
    await q(
      `update proposals set status = 'withdrawn', reviewed_at = now() where id = $1`,
      [refiled.id]
    );
    await fileCleanupPacks(NOW);
    expect(await packs(A)).toHaveLength(3);
    expect(refsOf(await latest(A))).toEqual(
      [S(s.sessionA), K(s.probeA)].sort()
    );
  });

  it("a whole pack rejected within 30 days silences every item in it", async () => {
    await seedPod();
    await fileCleanupPacks(NOW);
    await q(
      `update proposals set status = 'rejected', reviewed_at = now() where id = $1`,
      [(await latest(A)).id]
    );

    const rescan = await fileCleanupPacks(NOW);

    expect(await packs(A)).toHaveLength(1);
    expect(rescan.suppressed.rejectedPack).toBe(2);
  });

  it("a keep past its window is proposed again — sessions (30d) before kinds (90d)", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    const first = await latest(A);
    await setData(first.id, {
      dispositions: {
        [S(s.sessionA)]: { status: "reject" },
        [K(s.probeA)]: { status: "reject" },
      },
    });
    await q(
      `update proposals set status = 'approved', reviewed_at = $2 where id = $1`,
      [first.id, new Date(NOW.getTime() - 31 * 86_400_000).toISOString()]
    );

    await fileCleanupPacks(NOW);

    expect(refsOf(await latest(A))).toEqual([S(s.sessionA)]);
  });

  it("an undecided pack older than 7 days is WITHDRAWN (not reviewed) and superseded by a fresh one", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    const old = await latest(A);
    await q(`update proposals set created_at = $2 where id = $1`, [
      old.id,
      new Date(NOW.getTime() - 8 * 86_400_000).toISOString(),
    ]);

    const rescan = await fileCleanupPacks(NOW);

    const after = await status("proposals", old.id);
    const fresh = await latest(A);
    expect(after!.status).toBe("withdrawn");
    expect(after!.reviewed_at).toBeNull();
    expect((after!.data as Record<string, unknown>).supersededBy).toBe(
      fresh.id
    );
    expect(fresh.id).not.toBe(old.id);
    expect(refsOf(fresh)).toEqual([S(s.sessionA), K(s.probeA)].sort());
    expect(rescan.superseded).toBe(1);
  });

  it("approval applies ONLY the kept-in items, records each outcome by ref, then marks approved", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    const packA = await latest(A);
    await setData(packA.id, {
      dispositions: { [K(s.probeA)]: { status: "reject" } },
    });

    const result = await approve(packA.id, A);

    expect(h.closeCalls).toEqual([{ sessionId: s.sessionA, userId: A }]);
    expect((await status("profiles", s.probeA))!.is_active).toBe(true);
    const row = await status("proposals", packA.id);
    expect(row!.status).toBe("approved");
    const outcomes = (
      row!.data as { outcomes: Record<string, { outcome: string }> }
    ).outcomes;
    expect(outcomes[S(s.sessionA)]!.outcome).toBe("applied");
    expect(outcomes[K(s.probeA)]!.outcome).toBe("skipped_by_reviewer");
    expect(result.effect).toMatchObject({ applied: "verified", rows: 1 });
  });

  it("a session active again — or merely touched — since filing is REFUSED by name, not closed, and then settles", async () => {
    const resumed = await staleSession(A);
    await q(`update focus_sessions set title = 'Resumed work' where id = $1`, [
      resumed,
    ]);
    const touched = await staleSession(A);
    await q(`update focus_sessions set title = 'Touched work' where id = $1`, [
      touched,
    ]);
    await fileCleanupPacks(NOW);
    const packA = await latest(A);
    await q(
      `update focus_sessions set status = 'active', updated_at = now() where id = $1`,
      [resumed]
    );
    // Still `stale`, but activity after the snapshot the reviewer saw.
    await q(`update focus_sessions set updated_at = now() where id = $1`, [
      touched,
    ]);

    const result = await approve(packA.id, A);

    expect(h.closeCalls).toEqual([]);
    expect(result.refusals).toEqual(
      expect.arrayContaining([
        "Resumed work (session): Active again since this pack was filed",
        "Touched work (session): Active again since this pack was filed",
      ])
    );

    // Both go idle again; the refusal settles, so neither is re-proposed yet.
    await q(
      `update focus_sessions set status = 'stale', updated_at = $2 where id = any($1::uuid[])`,
      [[resumed, touched], OLD]
    );
    const rescan = await fileCleanupPacks(NOW);
    expect(rescan.suppressed.refused).toBe(2);
    expect(await packs(A)).toHaveLength(1);
  });

  it("a retire item whose kind gained a record since filing is refused, keyed by the kind's name", async () => {
    const s = await seedPod();
    await fileCleanupPacks(NOW);
    const packA = await latest(A);
    await entity(s.probeA, B, WS_B);

    const result = await approve(packA.id, A);

    expect((await status("profiles", s.probeA))!.is_active).toBe(true);
    expect(
      result.refusals?.some((r) =>
        /^Zero A \(kind\): Retire refused at approval/.test(r)
      )
    ).toBe(true);
  });

  it("a legacy v1 pack still applies", async () => {
    const legacySession = await staleSession(A);
    const id = randomUUID();
    await q(
      `insert into proposals (id, status, workspace_id, target_type, target_id, proposal_type, data,
         created_by, subject_user_id, created_at, updated_at)
       values ($1, 'pending', null, 'pod_hygiene', $2, 'cleanup_pack', $3::jsonb, $2, $2, now(), now())`,
      [
        id,
        A,
        JSON.stringify({
          sourceId: A,
          items: [
            {
              ref: "$item0",
              action: "close_session",
              targetId: legacySession,
              label: "Legacy",
              reason: "old copy",
            },
            {
              ref: "$item1",
              action: "close_session",
              targetId: randomUUID(),
              label: "Gone",
              reason: "Can be undone later",
            },
          ],
        }),
      ]
    );

    const result = await approve(id, A);

    expect(h.closeCalls).toEqual([{ sessionId: legacySession, userId: A }]);
    const row = await status("proposals", id);
    expect(row!.status).toBe("approved");
    expect(
      (row!.data as { outcomes: Record<string, { outcome: string }> }).outcomes
        .$item0!.outcome
    ).toBe("applied");
    // The refusal is the door's sentence, never the stored v1 `reason` (it promised undo).
    expect(result.refusals).toEqual(["Gone (session): No longer exists"]);
  });

  it("a crash mid-loop leaves a true partial record; re-approving finishes without re-applying", async () => {
    const first = await staleSession(A, "2026-06-01T00:00:00Z");
    const second = await staleSession(A, "2026-07-01T00:00:00Z");
    await fileCleanupPacks(NOW);
    const packA = await latest(A);
    // The second item's door fails AND the outcome write after it fails: the
    // executor dies between items, the way a lost connection would.
    h.beforeClose = async (sessionId) => {
      if (sessionId !== second) return;
      await q(`alter table proposals rename to proposals_offline`);
      throw new Error("connection lost");
    };

    await expect(approve(packA.id, A)).rejects.toThrow();

    h.beforeClose = null;
    await q(`alter table proposals_offline rename to proposals`);
    const partial = await status("proposals", packA.id);
    expect(partial!.status).toBe("pending");
    expect(
      (partial!.data as { outcomes: Record<string, { outcome: string }> })
        .outcomes
    ).toEqual({ [S(first)]: expect.objectContaining({ outcome: "applied" }) });
    expect(h.closeCalls.map((c) => c.sessionId)).toEqual([first]);

    const retry = await approve(packA.id, A);

    expect(h.closeCalls.map((c) => c.sessionId)).toEqual([first, second]);
    const done = await status("proposals", packA.id);
    expect(done!.status).toBe("approved");
    const outcomes = (
      done!.data as { outcomes: Record<string, { outcome: string }> }
    ).outcomes;
    expect(outcomes[S(first)]!.outcome).toBe("applied");
    expect(outcomes[S(second)]!.outcome).toBe("applied");
    expect(retry.refusals).toBeUndefined();
    expect(retry.effect).toMatchObject({ applied: "verified", rows: 2 });
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
