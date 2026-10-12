/**
 * `enableWorker` against real SQL (PGlite) — the OVERLAP rule (work model L4).
 *
 *  - refused when the worker is LIVE for the whole space, or for the same
 *    project (another track of it included), with the WORKER_SCOPE_OVERLAP
 *    code and the holder named — asserted on the code, not on "it threw";
 *  - allowed for two DIFFERENT projects;
 *  - a paused space-wide run does not block a project enablement;
 *  - re-enabling an enablement a person disabled turns the SAME rule back on.
 *
 * Mocked, each proven elsewhere: the rule door (a stateful fake that writes
 * the rule row exactly as `createRuleGoverned` stamps it — so the overlap
 * read runs on real rows), project/track filing, the activator pass.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 180_000 });

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
  const db = drizzle(client, {
    schema: { profiles: actual.profiles as never },
  });
  const mocked = {
    ...actual,
    getDb: async () => db,
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
} from "@synap/database";
import { WORKER_SCOPE_OVERLAP, enableWorker } from "../workers.js";
import { updateRuleGoverned } from "../../rules/update.js";
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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

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
  await h.client!.exec("delete from skills;");
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
