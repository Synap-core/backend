/**
 * `enableWorker` against real SQL (PGlite) — the OVERLAP rule (work model L4).
 *
 *  - refused when the worker is LIVE for the whole space, or for the same
 *    project (another track of it included), with the WORKER_SCOPE_OVERLAP
 *    code and the holder named — asserted on the code, not on "it threw";
 *  - allowed for two DIFFERENT projects;
 *  - a paused space-wide run does not block a project enablement;
 *  - re-enabling an enablement a person disabled turns the SAME rule back on;
 *  - FB2 item 4: the race settles on the SMALLEST live id, a step-back that
 *    did not apply is never reported as a refusal, and RESUME and the
 *    approval of an agent's enable/resume run the same overlap check.
 *
 * Mocked, each proven elsewhere: the rule door (a stateful fake that writes
 * the rule row exactly as `createRuleGoverned` stamps it — so the overlap
 * read runs on real rows), project/track filing, the activator pass.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 180_000 });

const h = vi.hoisted(() => ({
  bulkCalls: [] as string[][],
  pending: new Map<string, number>(),
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
  const db = drizzle(client, {
    schema: { profiles: actual.profiles as never },
  });
  const mocked = {
    ...actual,
    getDb: async () => db,
    // Its SQL is proven in database `worker-enablement.pglite.test.ts`; here
    // it reads the fixture's pending map and records each call.
    countWorkerPendingApprovalsBulk: async (ids: readonly string[]) => {
      h.bulkCalls.push([...ids]);
      return new Map(ids.map((id) => [id, h.pending.get(id) ?? 0]));
    },
    ProfileResolutionService: class {
      async getEffectiveLifecycle() {
        return { propertySlug: "commercialStage" };
      }
    },
  };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});

async function insertRule(input: {
  intent: string;
  scope: unknown;
  sentence?: unknown;
  seed?: unknown;
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into skills (id, user_id, name, category, metadata) values ($1, 'user-1', 'rule', 'rule', $2::jsonb)`,
    [
      id,
      JSON.stringify({
        rule: {
          v: 1,
          intent: input.intent,
          scope: input.scope,
          sentence: input.sentence,
          seed: input.seed,
          behaviours: [],
        },
      }),
    ]
  );
  return id;
}
vi.mock("../../rules/create.js", () => ({
  createRuleGoverned: vi.fn(
    async (input: Parameters<typeof insertRule>[0]) => ({
      status: "created",
      ruleId: await insertRule(input),
      automationIds: [],
    })
  ),
}));
vi.mock("../../rules/update.js", () => ({
  updateRuleGoverned: vi.fn(
    async (input: { ruleId: string; draft?: boolean }) => {
      await h.client!.query(
        input.draft
          ? `update skills set metadata = jsonb_set(metadata, '{rule,draft}', 'true') where id = $1`
          : `update skills set metadata = metadata #- '{rule,draft}' where id = $1`,
        [input.ruleId]
      );
      return { status: "updated", ruleId: input.ruleId, automationIds: [] };
    }
  ),
}));
vi.mock("../playbook-activators.js", async (importOriginal) => ({
  // NB: `convergeActivatorsAtBoot` calls the module's OWN pass, not this mock.
  ...(await importOriginal<Record<string, unknown>>()),
  applyPlaybookActivators: vi.fn(async () => ({
    status: "applied",
    outcomes: [],
  })),
}));
vi.mock("../../projects/load-visible-project.js", () => ({
  loadVisibleProject: vi.fn(async (_db: unknown, id: string) => ({ id })),
}));
vi.mock("../../tracks/tracks-service.js", () => ({
  resolveTrackFiling: vi.fn(async (p: { trackId: string }) => ({
    projectId: TRACK_PROJECT[p.trackId],
    trackId: p.trackId,
    trackStage: null,
  })),
}));

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  playbooks,
  skills,
  profiles,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  users,
  links,
  automations,
  proposals,
  focusSessions,
  playbookAutomations,
} from "@synap/database";
import {
  WORKER_SCOPE_OVERLAP,
  assertNoWorkerOverlap,
  enableWorker,
  listEnabledWorkers,
  setWorkerPaused,
} from "../workers.js";
import { updateRuleGoverned } from "../../rules/update.js";
import {
  ACTIVATOR_COMPILE_VERSION,
  convergeActivatorsAtBoot,
} from "../playbook-activators.js";
import { createRuleGoverned } from "../../rules/create.js";

const USER = "user-1";
const WS = "55555555-5555-4555-8555-555555555555";
const PB = "66666666-6666-4666-8666-666666666666";
const P1 = "77777777-7777-4777-8777-777777777777";
const P2 = "88888888-8888-4888-8888-888888888888";
const T1 = "99999999-9999-4999-8999-999999999991";
const T2 = "99999999-9999-4999-8999-999999999992";
const TRACK_PROJECT: Record<string, string> = { [T1]: P1, [T2]: P1 };
const KEY = "enters_status:review";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [
    playbooks,
    skills,
    profiles,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    users,
    links,
    automations,
    proposals,
    focusSessions,
    playbookAutomations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(`insert into users (id, email) values ($1, 'u@example.test')`, [
    USER,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Sales', $2)`,
    [WS, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values (gen_random_uuid(), 'deal', 'Deal', 'kind', 'workspace')`
  );
  await q(
    `insert into playbooks (id, name, status, workspace_id, created_by, goal_template, subject_profile)
     values ($1, 'Review', 'active', $2, $3, 'g', $4::jsonb)`,
    [
      PB,
      WS,
      USER,
      JSON.stringify({
        profileSlug: "deal",
        activators: [
          { on: "enters_status", status: "review", mode: "propose" },
        ],
      }),
    ]
  );
});

beforeEach(async () => {
  await h.client!.exec(
    "delete from skills; delete from links; delete from automations; delete from proposals; delete from focus_sessions;"
  );
  vi.mocked(updateRuleGoverned).mockClear();
});

const enable = (o: { projectId?: string; trackId?: string }) =>
  enableWorker({ userId: USER, playbookId: PB, activatorKey: KEY, ...o });
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { reasonCode?: string; holder?: unknown }) => ({
      code: e.reasonCode ?? "OTHER",
      holder: e.holder,
    })
  );
async function spaceRule(draft: boolean) {
  const id = await insertRule({
    intent: "space",
    scope: { kind: "workspace", workspaceId: WS },
    seed: { template: `playbook-activator:${PB}`, key: KEY, hash: "h" },
  });
  if (draft)
    await q(
      `update skills set metadata = jsonb_set(metadata, '{rule,draft}', 'true') where id = $1`,
      [id]
    );
  return id;
}

describe("enableWorker — overlap is refused, naming the holder", () => {
  it("LIVE for the whole space → WORKER_SCOPE_OVERLAP (space holder)", async () => {
    const holder = await spaceRule(false);
    expect(await refusal(enable({ projectId: P1 }))).toEqual({
      code: WORKER_SCOPE_OVERLAP,
      holder: {
        ruleId: holder,
        scope: "space",
        projectId: null,
        trackId: null,
      },
    });
    // Refused BEFORE anything was written.
    const { rows } = await q(`select count(*)::int as n from skills`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("a PAUSED space run does not block a project", async () => {
    await spaceRule(true);
    expect(await enable({ projectId: P1 })).toMatchObject({
      status: "enabled",
    });
  });

  it("the same project twice — and a second track of that project — is refused", async () => {
    const first = await enable({ trackId: T1 });
    expect(first).toMatchObject({ status: "enabled" });
    const again = await refusal(enable({ projectId: P1 }));
    expect(again?.code).toBe(WORKER_SCOPE_OVERLAP);
    expect(again?.holder).toMatchObject({
      scope: "project",
      projectId: P1,
      trackId: T1,
    });
    expect((await refusal(enable({ trackId: T2 })))?.code).toBe(
      WORKER_SCOPE_OVERLAP
    );
  });

  it("two DIFFERENT projects never overlap", async () => {
    expect(await enable({ projectId: P1 })).toMatchObject({
      status: "enabled",
    });
    expect(await enable({ projectId: P2 })).toMatchObject({
      status: "enabled",
    });
    const { rows } = await q(`select count(*)::int as n from skills`);
    expect((rows[0] as { n: number }).n).toBe(2);
  });

  it("re-enabling an enablement a person DISABLED turns the same rule back on", async () => {
    const first = (await enable({ projectId: P1 })) as { ruleId: string };
    await q(
      `update skills set metadata = jsonb_set(metadata, '{rule,draft}', 'true') where id = $1`,
      [first.ruleId]
    );
    expect(await enable({ projectId: P1 })).toEqual({
      status: "enabled",
      ruleId: first.ruleId,
      reactivated: true,
    });
    const { rows } = await q(`select count(*)::int as n from skills`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("enableWorker — a race past the check", () => {
  it("two enables that both passed the check: the later row steps back to a draft and its caller is refused", async () => {
    // Another process's enable of the same (worker, project) lands between
    // our check and our write — with the SMALLER id, so it is the survivor.
    const RIVAL = "00000000-0000-4000-8000-000000000001";
    vi.mocked(createRuleGoverned).mockImplementationOnce(async (input) => {
      await q(
        `insert into skills (id, user_id, name, category, metadata) values ($1, 'user-1', 'rule', 'rule', $2::jsonb)`,
        [
          RIVAL,
          JSON.stringify({
            rule: {
              v: 1,
              intent: "rival",
              scope: {},
              seed: {
                template: `playbook-worker:${PB}`,
                key: `${KEY}@project:${P1}`,
                hash: "h",
              },
              behaviours: [],
            },
          }),
        ]
      );
      return {
        status: "created",
        ruleId: await insertRule(input as never),
        automationIds: [],
      } as never;
    });
    const out = await refusal(enable({ projectId: P1 }));
    expect(out?.code).toBe(WORKER_SCOPE_OVERLAP);
    expect(out?.holder).toMatchObject({ ruleId: RIVAL });
    const { rows } = await q(
      `select id, (metadata->'rule'->>'draft') as draft from skills order by id`
    );
    expect(rows).toEqual([
      { id: RIVAL, draft: null },
      { id: expect.any(String), draft: "true" },
    ]);
  });
});

/** A live (or paused) project enablement row with a chosen id. */
async function projectRule(id: string, projectId: string, draft = false) {
  await q(
    `insert into skills (id, user_id, name, category, metadata) values ($1, 'user-1', 'rule', 'rule', $2::jsonb)`,
    [
      id,
      JSON.stringify({
        rule: {
          v: 1,
          intent: "rival",
          scope: {},
          seed: {
            template: `playbook-worker:${PB}`,
            key: `${KEY}@project:${projectId}`,
            hash: "h",
          },
          behaviours: [],
          ...(draft ? { draft: true } : {}),
        },
      }),
    ]
  );
  return id;
}

describe("enableWorker — FB2 item 4: the race names the smallest holder", () => {
  it("three concurrent enables (A < ours < C): ours sees A, not C, and steps back", async () => {
    const A = "00000000-0000-4000-8000-000000000001";
    const OURS = "80000000-0000-4000-8000-000000000000";
    const C = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    vi.mocked(createRuleGoverned).mockImplementationOnce(async (input) => {
      // C is written FIRST, so a holder picked in row order is C (> ours).
      await projectRule(C, P1);
      await projectRule(A, P1);
      const ours = input as unknown as {
        intent: string;
        scope: unknown;
        seed: unknown;
      };
      await q(
        `insert into skills (id, user_id, name, category, metadata) values ($1, 'user-1', 'rule', 'rule', $2::jsonb)`,
        [
          OURS,
          JSON.stringify({
            rule: {
              v: 1,
              intent: ours.intent,
              scope: ours.scope,
              seed: ours.seed,
              behaviours: [],
            },
          }),
        ]
      );
      return { status: "created", ruleId: OURS, automationIds: [] } as never;
    });
    const out = await refusal(enable({ projectId: P1 }));
    expect(out?.code).toBe(WORKER_SCOPE_OVERLAP);
    expect(out?.holder).toMatchObject({ ruleId: A });
    const { rows } = await q(
      `select (metadata->'rule'->>'draft') as draft from skills where id = $1`,
      [OURS]
    );
    expect(rows).toEqual([{ draft: "true" }]);
  });

  it("a step-back the rule door did not apply is an error, never an overlap refusal", async () => {
    const RIVAL = "00000000-0000-4000-8000-000000000001";
    vi.mocked(createRuleGoverned).mockImplementationOnce(async (input) => {
      await projectRule(RIVAL, P1);
      return {
        status: "created",
        ruleId: await insertRule(input as never),
        automationIds: [],
      } as never;
    });
    vi.mocked(updateRuleGoverned).mockImplementationOnce(
      async () => ({ status: "proposed", proposalId: "prop-1" }) as never
    );
    const err = await enable({ projectId: P1 }).then(
      () => null,
      (e: { code?: string; reasonCode?: string; message: string }) => e
    );
    expect(err?.reasonCode).toBeUndefined();
    expect(err?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(err?.message).toMatch(/could not step back \(proposed\)/);
  });
});

describe("setWorkerPaused — FB2 item 4: resume runs the overlap check", () => {
  it("resuming the space run while a project runs it is refused, naming the project", async () => {
    const space = await spaceRule(true);
    const p1 = await projectRule("00000000-0000-4000-8000-0000000000aa", P1);
    expect(
      await refusal(
        setWorkerPaused({ userId: USER, ruleId: space, paused: false })
      )
    ).toEqual({
      code: WORKER_SCOPE_OVERLAP,
      holder: { ruleId: p1, scope: "project", projectId: P1, trackId: null },
    });
    expect(updateRuleGoverned).not.toHaveBeenCalled();
  });

  it("resuming a project while the space run is live is refused", async () => {
    const space = await spaceRule(false);
    const p1 = await projectRule(randomUUID(), P1, true);
    expect(
      (
        await refusal(
          setWorkerPaused({ userId: USER, ruleId: p1, paused: false })
        )
      )?.holder
    ).toMatchObject({ ruleId: space, scope: "space" });
  });

  it("a resume with nothing else live goes through; pausing never checks", async () => {
    const p1 = await projectRule(randomUUID(), P1, true);
    await projectRule(randomUUID(), P2);
    expect(
      await setWorkerPaused({ userId: USER, ruleId: p1, paused: false })
    ).toEqual({ status: "updated", state: "running" });
    await spaceRule(false);
    expect(
      await setWorkerPaused({ userId: USER, ruleId: p1, paused: true })
    ).toEqual({ status: "updated", state: "paused" });
  });
});

describe("assertNoWorkerOverlap — FB2 item 4: the approval of an agent's enable/resume", () => {
  it("a create's seed for a project the space already runs is refused", async () => {
    await spaceRule(false);
    await expect(
      assertNoWorkerOverlap({
        seed: {
          template: `playbook-worker:${PB}`,
          key: `${KEY}@project:${P1}`,
        },
      })
    ).rejects.toMatchObject({ reasonCode: WORKER_SCOPE_OVERLAP });
  });

  it("an update with no seed reads the rule's own, and leaves the rule itself out", async () => {
    const space = await spaceRule(true);
    expect(await assertNoWorkerOverlap({ ruleId: space })).toBeUndefined();
    await projectRule(randomUUID(), P1);
    await expect(
      assertNoWorkerOverlap({ ruleId: space })
    ).rejects.toMatchObject({
      reasonCode: WORKER_SCOPE_OVERLAP,
    });
  });

  it("a rule that is not a worker's passes", async () => {
    await spaceRule(false);
    expect(
      await assertNoWorkerOverlap({ seed: { template: "pack:x", key: KEY } })
    ).toBeUndefined();
  });
});

describe("listEnabledWorkers — FB2 item 9: a constant number of reads", () => {
  /** A rule's live behaviour: an automation + the activates edge. */
  async function behaviour(ruleId: string, status: string) {
    const automationId = randomUUID();
    await q(
      `insert into automations (id, created_by, name, status) values ($1, $2, 'a', $3)`,
      [automationId, USER, status]
    );
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'skill', $2, 'automation', $3, 'activates', '{}'::jsonb)`,
      [randomUUID(), ruleId, automationId]
    );
    return automationId;
  }
  function pendingIn(automationId: string, n: number) {
    h.pending.set(automationId, n);
  }
  /** Statements PGlite runs while `fn` does. */
  async function readsDuring(fn: () => Promise<unknown>) {
    const client = h.client as unknown as {
      query: (...a: unknown[]) => Promise<unknown>;
    };
    const real = client.query.bind(client);
    let n = 0;
    client.query = (...a: unknown[]) => {
      n++;
      return real(...a);
    };
    try {
      await fn();
    } finally {
      client.query = real;
    }
    return n;
  }

  it("each row carries its active automation and its pending count", async () => {
    const space = await spaceRule(false);
    const spaceAuto = await behaviour(space, "active");
    await behaviour(space, "archived");
    await pendingIn(spaceAuto, 2);
    const p1 = await projectRule(randomUUID(), P1);
    await behaviour(p1, "archived");
    const paused = await projectRule(randomUUID(), P2, true);
    const rows = await listEnabledWorkers({ userId: USER });
    const by = Object.fromEntries(rows.map((r) => [r.ruleId, r]));
    expect(by[space]).toMatchObject({
      state: "running",
      automationId: spaceAuto,
      pendingApprovals: 2,
    });
    expect(by[p1]).toMatchObject({ automationId: null, pendingApprovals: 0 });
    expect(by[paused]).toMatchObject({ state: "paused", automationId: null });
    expect(
      (await listEnabledWorkers({ userId: USER, liveOnly: true })).map(
        (r) => r.ruleId
      )
    ).toEqual([space]);
  });

  it("five enablements cost the same reads as one (no per-rule query)", async () => {
    h.bulkCalls.length = 0;
    const one = await projectRule(randomUUID(), P1);
    await pendingIn(await behaviour(one, "active"), 1);
    const base = await readsDuring(() => listEnabledWorkers({ userId: USER }));
    expect(base).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      const r = await projectRule(randomUUID(), randomUUID());
      await pendingIn(await behaviour(r, "active"), 1);
    }
    const rows = await listEnabledWorkers({ userId: USER });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.pendingApprovals === 1)).toBe(true);
    expect(await readsDuring(() => listEnabledWorkers({ userId: USER }))).toBe(
      base
    );
    // One pending read per list, over every live automation at once.
    expect(h.bulkCalls.at(-1)).toHaveLength(5);
  });
});

describe("convergeActivatorsAtBoot — D4: once per compile version", () => {
  async function playbook(o: {
    activators: unknown[];
    status?: string;
    metadata?: unknown;
  }) {
    const id = randomUUID();
    await q(
      `insert into playbooks (id, name, status, workspace_id, created_by, goal_template, subject_profile, metadata)
       values ($1, 'P', $2, $3, $4, 'g', $5::jsonb, $6::jsonb)`,
      [
        id,
        o.status ?? "active",
        WS,
        USER,
        JSON.stringify({ profileSlug: "deal", activators: o.activators }),
        JSON.stringify(o.metadata ?? {}),
      ]
    );
    return id;
  }
  const rulesOf = async (pbId: string) =>
    (
      await q<{ n: number }>(
        `select count(*)::int as n from skills where metadata->'rule'->'seed'->>'template' = $1`,
        [`playbook-activator:${pbId}`]
      )
    ).rows[0]!.n;
  const versionOf = async (pbId: string) =>
    (
      await q<{ v: string | null }>(
        `select metadata->'activatorRules'->>'compileVersion' as v from playbooks where id = $1`,
        [pbId]
      )
    ).rows[0]!.v;

  it("converges the playbooks behind the compile version and stamps them; skips the current and the paused", async () => {
    const CREATED = [{ on: "created", mode: "propose" }];
    const behind = await playbook({ activators: CREATED });
    const current = await playbook({
      activators: CREATED,
      metadata: {
        activatorRules: {
          template: "x",
          rules: {},
          compileVersion: ACTIVATOR_COMPILE_VERSION,
        },
      },
    });
    // The memory's version only counts for ITS template: here it does.
    await q(
      `update playbooks set metadata = jsonb_set(metadata, '{activatorRules,template}', to_jsonb($2::text)) where id = $1`,
      [current, `playbook-activator:${current}`]
    );
    const paused = await playbook({ activators: CREATED, status: "paused" });

    const r = await convergeActivatorsAtBoot();
    expect(r.failed).toBe(0);
    expect(await rulesOf(behind)).toBe(1);
    expect(await versionOf(behind)).toBe(String(ACTIVATOR_COMPILE_VERSION));
    expect(await rulesOf(current)).toBe(0);
    expect(await rulesOf(paused)).toBe(0);

    await q(`delete from playbooks where id = any($1::uuid[])`, [
      [behind, current, paused],
    ]);
  });
});
