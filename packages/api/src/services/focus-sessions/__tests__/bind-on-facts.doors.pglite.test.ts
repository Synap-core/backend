/**
 * BIND ON FACTS through the doors an agent and a person actually reach
 * (founder decisions d01–d03, review of backend#855), on PGlite:
 *   - MCP `synap_start_session` / `synap_update_session` (the AI doors);
 *   - Hub REST `POST /focus-sessions` and `PATCH /focus-sessions/:id`;
 *   - the capture path (`nameCapturedSubject`, what Relay's capture reaches);
 *   - the replay of a held start (`replayDeferredWrites`).
 *
 * The playbooks under test are the LIVE definitions of 2026-11-05
 * (`__fixtures__/live-active-playbooks-2026-11-05.json`): "Fix a finding"
 * (18abd1ea, declares no statusProperty), "Design to implementation"
 * (2802e46a, a required `design` entity param) and "Turn a finding into
 * content" (a42eb6b2, Research space).
 *
 * Real: the MCP handlers, the Hub routes, `createFocusSession`,
 * `updateFocusSession`, `followPlaybook`, `bindOnFacts`, the ladder, the
 * replay door, and the PERMISSION FLOOR for a capability widening
 * (`grant_capability` goes to the real `checkPermissionOrPropose`).
 * Stubbed: every other governance verdict (granted, or one held start for
 * the replay row), the session room, realtime, block guidance, project
 * placement, the spawn edge, the TEXT matcher, and the track filing resolver
 * (the goal door has its own suites; here it only has to land a `trackId`).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    parents: new Map<string, string>(),
    /** The next `focus_session/create` verdict is a held start (once). */
    holdNextStart: false,
    heldStartData: null as null | Record<string, unknown>,
    track: null as null | string,
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
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    recordSessionSpawn: async (p: {
      childSessionId: string;
      parentSessionId: string;
    }) => {
      h.parents.set(p.childSessionId, p.parentSessionId);
      return { linked: true, suspendedIntentRecorded: false };
    },
    getParentSessionId: async (id: string) => h.parents.get(id) ?? null,
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: async (
      opts: Parameters<typeof actual.checkPermissionOrPropose>[0]
    ) => {
      // A capability widening is decided by the REAL floor (review item g).
      if (opts.action === "grant_capability") {
        return actual.checkPermissionOrPropose(opts);
      }
      if (
        h.holdNextStart &&
        opts.subjectType === "focus_session" &&
        opts.action === "create"
      ) {
        h.holdNextStart = false;
        h.heldStartData = (opts.data ?? {}) as Record<string, unknown>;
        return {
          granted: false,
          proposalId: randomUUID(),
          proposalType: "focus_session.create",
          summary: "held start",
        };
      }
      return { granted: true };
    },
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureSessionChannel: async () => null,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));
vi.mock("../match-session-template.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  matchSessionTemplate: async () => ({ candidates: [], optOut: "" }),
}));
vi.mock("../../tracks/session-track-filing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionTrackFiling: async () => ({
    set: { trackId: h.track, trackStage: null },
    trackName: "A goal",
    stageName: null,
    projectName: null,
    trackProjectId: null,
    projectWorkspaceId: null,
  }),
  stampTrackFilingUses: async () => false,
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type {
  HubHono,
  HubVariables,
} from "../../../routers/hub-protocol/rest/_shared.js";

const { sessionHandlers } =
  await import("../../../routers/mcp/handlers/session.js");
const { registerFocusSessionsRoutes } =
  await import("../../../routers/hub-protocol/rest/focus-sessions.js");
const { nameCapturedSubject } =
  await import("../../captures/captured-subject.js");
const { replayDeferredWrites } =
  await import("../../governance/deferred-writes.js");

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
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

// ── The live definitions ────────────────────────────────────────────────────
type LivePlaybook = {
  id: string;
  name: string;
  status: string;
  scope: string | null;
  workspaceId: string | null;
  subjectProfile: unknown;
  inputStrategy: unknown;
  stages: unknown;
  params: unknown;
};
const LIVE = (
  JSON.parse(
    readFileSync(
      new URL(
        "../__fixtures__/live-active-playbooks-2026-11-05.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { playbooks: LivePlaybook[] }
).playbooks;
const live = (id8: string): LivePlaybook => {
  const p = LIVE.find((x) => x.id.startsWith(id8));
  if (!p) throw new Error(`no live playbook ${id8}`);
  return p;
};
const FIX_FINDING = live("18abd1ea");
const DESIGN_TO_IMPL = live("2802e46a");
const FINDING_TO_CONTENT = live("a42eb6b2");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const BUILDER = FIX_FINDING.workspaceId!;
const RESEARCH = FINDING_TO_CONTENT.workspaceId!;
const FINDING_PROFILE = randomUUID();
const DESIGN_PROFILE = randomUUID();
const GIZMO_PROFILE = randomUUID();
const CAP_PLAYBOOK = randomUUID(); // pod-wide, runs on a gizmo, GRANTS a tool
const LANE_PLAYBOOK = randomUUID(); // pod-wide, one required text param

async function insertPlaybook(p: LivePlaybook) {
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, input_strategy, version, status, scope, created_at, updated_at)
     values ($1, $2, $3, $4, $4, 'external-agent', $5::jsonb, '[]'::jsonb, '[]'::jsonb,
             $6::jsonb, $7::jsonb, $8::jsonb, 1, $9, $10, now(), now())`,
    [
      p.id,
      p.workspaceId,
      USER,
      p.name,
      JSON.stringify(p.stages ?? []),
      JSON.stringify(p.params ?? []),
      p.subjectProfile == null ? null : JSON.stringify(p.subjectProfile),
      JSON.stringify(p.inputStrategy ?? { kind: "none" }),
      p.status,
      p.scope ?? "session",
    ]
  );
}

async function entityOf(
  profileId: string,
  workspaceId: string | null,
  extra: { properties?: Record<string, unknown>; statusCategory?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, status_category, created_at, updated_at)
     values ($1, $2, $3, $4, 'x', 'A thing', $5::jsonb, $6, now(), now())`,
    [
      id,
      USER,
      workspaceId,
      profileId,
      JSON.stringify(extra.properties ?? {}),
      extra.statusCategory ?? null,
    ]
  );
  return id;
}

type Row = {
  playbook_id: string | null;
  subject_entity_id: string | null;
  track_id: string | null;
  metadata: Record<string, unknown>;
  expected_outputs: Array<Record<string, unknown>> | null;
};
const rowOf = async (id: string): Promise<Row> =>
  (
    await q<Row>(
      `select playbook_id, subject_entity_id, track_id, metadata, expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;
const runsOf = async (id: string) =>
  (
    await q<{ playbook_id: string }>(
      `select playbook_id from playbook_runs where session_id = $1`,
      [id]
    )
  ).rows;

/** Depth-first: the first value under `key` anywhere in a reply. */
function find(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[key];
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const hit = find(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function mcp(
  tool: "synap_start_session" | "synap_update_session",
  args: Record<string, unknown>,
  agentUserId: string | undefined = AGENT
): Promise<Record<string, unknown>> {
  const res = await sessionHandlers[tool]!({
    toolName: tool,
    args,
    userId: USER,
    agentUserId,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

const CRITERIA = [
  { key: "done", statement: "The work is done", check: { kind: "human" } },
];

/** An agent's start over MCP; the session id. */
async function mcpStart(args: Record<string, unknown> = {}): Promise<string> {
  const out = await mcp("synap_start_session", {
    goal: `Work ${randomUUID()}`,
    workspaceId: BUILDER,
    criteria: CRITERIA,
    forceCreate: true,
    ...args,
  });
  const id = find(out, "id");
  if (typeof id !== "string") throw new Error(JSON.stringify(out));
  return id;
}

function hub(agent: boolean): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (agent) c.set("agentUserId", AGENT);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table the generator cannot express is not read by these doors.
      }
    }
  }
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, email, name, user_type, created_by_user_id) values ($1, 'agent@x.test', 'Agent', 'agent', $2)`,
    [AGENT, USER]
  );
  for (const [ws, name] of [
    [BUILDER, "Builder"],
    [RESEARCH, "Research"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [ws, name, USER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, USER]
    );
  }
  for (const [id, slug] of [
    [FINDING_PROFILE, "finding"],
    [DESIGN_PROFILE, "ui-design"],
    [GIZMO_PROFILE, "gizmo"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, scope, created_at, updated_at) values ($1, $2, $2, 'system', now(), now())`,
      [id, slug]
    );
  }
  await insertPlaybook(FIX_FINDING);
  await insertPlaybook(DESIGN_TO_IMPL);
  await insertPlaybook(FINDING_TO_CONTENT);
  await insertPlaybook({
    id: CAP_PLAYBOOK,
    name: "Tune a gizmo",
    status: "active",
    scope: "session",
    workspaceId: null,
    subjectProfile: { profileSlug: "gizmo" },
    inputStrategy: { kind: "none" },
    stages: [],
    params: [],
  });
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values (gen_random_uuid(), 'playbook', $1, 'tool', $2, 'grants', '{}'::jsonb, now())`,
    [CAP_PLAYBOOK, randomUUID()]
  );
  await insertPlaybook({
    id: LANE_PLAYBOOK,
    name: "Ship on a repo",
    status: "active",
    scope: "session",
    workspaceId: null,
    subjectProfile: null,
    inputStrategy: { kind: "none" },
    stages: [],
    params: [{ name: "repo", type: "text", required: true }],
  });
}, 120_000);

describe("M1: only an AI door's own subject re-runs the facts", () => {
  it("a person's capture naming the subject binds nothing; the MCP update with a subject binds once", async () => {
    const captured = await mcpStart();
    const named = await nameCapturedSubject({
      sessionId: captured,
      userId: USER,
      anchorEntityId: await entityOf(FINDING_PROFILE, BUILDER),
      entityIds: [],
    });
    expect(named.status).toBe("named");
    const afterCapture = await rowOf(captured);
    expect(afterCapture.subject_entity_id).not.toBeNull();
    expect(afterCapture.playbook_id).toBeNull();
    expect(afterCapture.metadata.bindRecheckedAt).toBeUndefined();
    expect(await runsOf(captured)).toEqual([]);

    const agentSession = await mcpStart();
    const out = await mcp("synap_update_session", {
      sessionId: agentSession,
      subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER),
    });
    expect(find(out, "binding"), JSON.stringify(out)).toEqual(
      expect.stringContaining(FIX_FINDING.id)
    );
    const row = await rowOf(agentSession);
    expect(row.playbook_id).toBe(FIX_FINDING.id);
    expect(row.metadata.boundBy).toMatchObject({
      rung: "subject",
      phase: "update",
    });
    expect(await runsOf(agentSession)).toEqual([
      { playbook_id: FIX_FINDING.id },
    ]);
  });
});

describe("M2: a goal arriving does not use up the one re-resolve", () => {
  it("goal first, subject later: binds at the subject", async () => {
    const id = await mcpStart();
    h.track = randomUUID();
    const filed = await mcp(
      "synap_update_session",
      { sessionId: id, trackId: h.track },
      undefined
    );
    expect(find(filed, "binding")).toBeUndefined();
    const afterGoal = await rowOf(id);
    expect(afterGoal.track_id, JSON.stringify(filed)).toBe(h.track);
    expect(afterGoal.metadata.bindRecheckedAt).toBeUndefined();

    const out = await mcp(
      "synap_update_session",
      {
        sessionId: id,
        subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER),
      },
      undefined
    );
    expect(find(out, "binding")).toEqual(
      expect.stringContaining(FIX_FINDING.id)
    );
    expect((await rowOf(id)).playbook_id).toBe(FIX_FINDING.id);
  });
});

describe("M3: the subject answers the bound playbook's entity param", () => {
  it("an agent's start about a ui-design binds 'Design to implementation' and owes the person no param", async () => {
    const design = await entityOf(DESIGN_PROFILE, BUILDER, {
      properties: { "design-status": "draft" },
    });
    const id = await mcpStart({ subjectEntityId: design });
    const row = await rowOf(id);
    expect(row.playbook_id).toBe(DESIGN_TO_IMPL.id);
    expect(row.metadata.params).toMatchObject({ design });
    expect(
      (row.expected_outputs ?? []).filter((o) => o.paramName !== undefined)
    ).toEqual([]);
  });
});

describe("M4: the Hub REST start says the binding line", () => {
  it("an agent key's POST /focus-sessions with a finding binds and carries `binding`", async () => {
    const res = await hub(true).request("/focus-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: USER,
        workspaceId: BUILDER,
        goal: `Fix it ${randomUUID()}`,
        criteria: CRITERIA,
        forceCreate: true,
        subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.playbookId).toBe(FIX_FINDING.id);
    expect(body.binding).toEqual(expect.stringContaining(FIX_FINDING.id));
  });

  it("the capture path (X-Capture: 1) binds nothing: a person capturing through a key", async () => {
    const res = await hub(true).request("/focus-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture": "1" },
      body: JSON.stringify({
        userId: USER,
        workspaceId: BUILDER,
        goal: `Captured ${randomUUID()}`,
        forceCreate: true,
        subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.playbookId ?? null).toBeNull();
    expect(body.binding).toBeUndefined();
  });
});

describe("M5: a finished session is never bound", () => {
  it.each(["closed", "cancelled", "failed"])(
    "a %s session given its first subject binds nothing",
    async (status) => {
      const id = await mcpStart();
      await q(`update focus_sessions set status = $2 where id = $1`, [
        id,
        status,
      ]);
      const out = await mcp("synap_update_session", {
        sessionId: id,
        subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER),
      });
      expect(find(out, "binding")).toBeUndefined();
      const row = await rowOf(id);
      expect(row.playbook_id).toBeNull();
      expect(row.metadata.bindRecheckedAt).toBeUndefined();
      expect(await runsOf(id)).toEqual([]);
    }
  );
});

describe("(a) the Hub REST PATCH keeps the same once-only rule", () => {
  it("an agent key's first subject binds once; a second subject does not re-run", async () => {
    const id = await mcpStart();
    const patch = (body: Record<string, unknown>) =>
      hub(true).request(`/focus-sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await patch({
      subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.binding).toEqual(expect.stringContaining(FIX_FINDING.id));
    expect((await rowOf(id)).playbook_id).toBe(FIX_FINDING.id);
  });
});

describe("(b) one open session per playbook per subject", () => {
  it("a second session about the same finding is not bound to 'Fix a finding' again", async () => {
    const finding = await entityOf(FINDING_PROFILE, BUILDER);
    const first = await mcpStart({ subjectEntityId: finding });
    expect((await rowOf(first)).playbook_id).toBe(FIX_FINDING.id);
    const out = await mcp("synap_start_session", {
      goal: `Again ${randomUUID()}`,
      workspaceId: BUILDER,
      criteria: CRITERIA,
      forceCreate: true,
      subjectEntityId: finding,
    });
    const second = find(out, "id") as string;
    expect((await rowOf(second)).playbook_id).toBeNull();
    expect(find(out, "binding")).toEqual(expect.stringContaining(first));
  });
});

describe("(c) a lane carries its parent's param answers", () => {
  it("the child follows the parent's playbook and owes no param the parent answered", async () => {
    const parent = await mcpStart({
      templateId: LANE_PLAYBOOK,
      params: { repo: "backend" },
    });
    expect((await rowOf(parent)).playbook_id).toBe(LANE_PLAYBOOK);
    const child = await mcpStart({ parentSessionId: parent });
    const row = await rowOf(child);
    expect(row.playbook_id).toBe(LANE_PLAYBOOK);
    expect(row.metadata.boundBy).toMatchObject({ rung: "parent" });
    expect(row.metadata.params).toMatchObject({ repo: "backend" });
    expect(
      (row.expected_outputs ?? []).filter((o) => o.paramName === "repo")
    ).toEqual([]);
  });
});

describe("(d) finished subjects and other spaces", () => {
  it("a finding whose lifecycle says done binds nothing", async () => {
    const id = await mcpStart({
      subjectEntityId: await entityOf(FINDING_PROFILE, BUILDER, {
        statusCategory: "done",
      }),
    });
    expect((await rowOf(id)).playbook_id).toBeNull();
  });

  it("a session in no space is not bound to a Research playbook because its finding lives in Research", async () => {
    const id = await mcpStart({
      workspaceId: undefined,
      subjectEntityId: await entityOf(FINDING_PROFILE, RESEARCH),
    });
    expect((await rowOf(id)).playbook_id).toBeNull();
  });
});

describe("(f) a held start binds once its replay lands", () => {
  it("the MCP start held for review carries bindOnFacts, and the replay binds", async () => {
    const finding = await entityOf(FINDING_PROFILE, BUILDER);
    h.holdNextStart = true;
    const out = await mcp("synap_start_session", {
      goal: `Held ${randomUUID()}`,
      workspaceId: BUILDER,
      criteria: CRITERIA,
      forceCreate: true,
      subjectEntityId: finding,
    });
    expect(find(out, "status")).toBe("proposed");
    const data = h.heldStartData!;
    expect(data.bindOnFacts).toBe(true);

    const proposalId = randomUUID();
    await q(`insert into proposals (id, data) values ($1, $2::jsonb)`, [
      proposalId,
      JSON.stringify({
        deferredWrites: [
          {
            ref: "w1",
            subjectType: "focus_session",
            action: "create",
            data,
            sessionId: null,
            agentUserId: AGENT,
            userId: USER,
            at: new Date().toISOString(),
            fingerprint: "held-start",
            workspaceId: BUILDER,
          },
        ],
      }),
    ]);
    const replay = await replayDeferredWrites({
      proposalId,
      workspaceId: BUILDER,
    });
    expect(replay.outcomes.w1?.outcome).toBe("applied");
    expect((await rowOf(String(data.id))).playbook_id).toBe(FIX_FINDING.id);
  });
});

describe("(g) a playbook that grants capabilities stays a proposal (real floor)", () => {
  it("facts never bind it, and an agent's own follow of it is held for review", async () => {
    const id = await mcpStart({
      subjectEntityId: await entityOf(GIZMO_PROFILE, BUILDER),
    });
    const start = await rowOf(id);
    expect(start.playbook_id).toBeNull();

    const out = await mcp("synap_update_session", {
      sessionId: id,
      followPlaybookId: CAP_PLAYBOOK,
    });
    expect(find(out, "followRefusal"), JSON.stringify(out)).toEqual(
      expect.stringMatching(/widen/i)
    );
    expect((await rowOf(id)).playbook_id).toBeNull();
    expect(await runsOf(id)).toEqual([]);
  });
});
