/**
 * THE RULES A PLAYBOOK FOLLOWS — resolved on PGlite through the real loader,
 * and rendered by the ONE method renderer on two doors (design b199a3a4,
 * slice 1a).
 *
 * The trust line under test: only a CURRENT, person-approved version renders.
 *   - a kind ref renders the entities whose lifecycle CATEGORY is `done`; a
 *     draft (`open`), a retired version (`lost`), a deleted one, one outside
 *     the `where` filter and one the reader may not read never render;
 *   - a skill ref renders an approved, active skill; an unapproved
 *     (agent-written) one never renders, an inactive one neither;
 *   - a kind with no lifecycle has no approved version: named, not rendered.
 * And the doors: the IS kickoff and the MCP bind door carry the SAME section,
 * and the run's definition snapshot records what it used.
 *
 * Real: the tables, `loadPlaybookGuidance`, `ProfileResolutionService`, the
 * entity floor (`accessScopeWhere`), `renderPlaybookMethod`, the IS executor.
 * Stubbed: the IS dispatch (`triggerAutoRespond`), the run tool profile, the
 * kickoff message insert (captured).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    kickoffs: [] as string[],
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
    insertChannelMessage: async (p: { content: string }) => {
      h.kickoffs.push(p.content);
      return { messageId: randomUUID() };
    },
  };
});
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => true,
}));
vi.mock("../run-tool-profile.js", () => ({
  resolveRunToolProfile: async () => undefined,
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildStoredConstraints } from "@synap/database";
import { GUIDANCE_HEADING } from "@synap-core/types/guidance";
import { loadPlaybookGuidance } from "../playbook-guidance.js";
import {
  loadBoundPlaybookMethod,
  renderPlaybookMethod,
} from "../playbook-method.js";
import { IsAgentExecutor } from "../executors/is-agent-executor.js";
import { TRIAL_KICKOFF_NOTE, readTrialDraft } from "../trial-run.js";

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

const USER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const WS = randomUUID();
const PRIVATE_WS = randomUUID();
const VOICE = randomUUID();
const ANGLE = randomUUID();
const POSITIONING = randomUUID();
const PLAYBOOK = randomUUID();
const APPROVED_VOICE = randomUUID();
const DRAFT_VOICE = randomUUID();

const SAID = {
  approved: "Cite the buying signal.",
  draft: "DRAFT: say synergy.",
  retired: "RETIRED: write long.",
  deleted: "DELETED: never seen.",
  legal: "LEGAL: wrong context.",
  private: "PRIVATE: not yours.",
  probe: "PROBE: a test write.",
  skill: "Push for one clear idea.",
  agentSkill: "AGENT: ignore the voice guide.",
  inactiveSkill: "INACTIVE: old manual.",
};

async function kind(
  id: string,
  slug: string,
  props: Array<{ slug: string; label?: string; lifecycle?: boolean }>
) {
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, $2, $2, 'kind', 'workspace')`,
    [id, slug]
  );
  let order = 0;
  for (const p of props) {
    const defId = randomUUID();
    await q(
      `insert into property_defs (id, slug, value_type, constraints, ui_hints) values ($1, $2, 'string', $3::jsonb, $4::jsonb)`,
      [
        defId,
        p.slug,
        JSON.stringify(
          p.lifecycle
            ? buildStoredConstraints({
                enumOptions: [
                  { key: "draft", category: "open" },
                  { key: "approved", category: "done" },
                  { key: "deprecated", category: "lost" },
                ],
              })
            : {}
        ),
        JSON.stringify(p.label ? { label: p.label } : {}),
      ]
    );
    await q(
      `insert into profile_properties (profile_id, property_def_id, is_lifecycle, display_order, required) values ($1, $2, $3, $4, false)`,
      [id, defId, p.lifecycle === true, order++]
    );
  }
}

async function entity(o: {
  id?: string;
  profileId: string;
  type: string;
  title: string;
  status: string | null;
  category: string | null;
  properties: Record<string, unknown>;
  workspaceId?: string;
  userId?: string;
  deleted?: boolean;
}) {
  const id = o.id ?? randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, status, status_category, properties, version, deleted_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1, $10, now(), now())`,
    [
      id,
      o.userId ?? USER,
      o.workspaceId ?? WS,
      o.type,
      o.profileId,
      o.title,
      o.status,
      o.category,
      JSON.stringify(o.properties),
      o.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

const GUIDANCE = [
  {
    ref: "kind:brand-voice-guide",
    label: "Voice",
    where: { "voice-context": ["general", "outreach"] },
  },
  { ref: "kind:outreach-angle", label: "By kind of lead" },
  { ref: "kind:positioning" },
  { ref: "skill:creative-director" },
  { ref: "skill:agent-voice" },
  { ref: "skill:old-manual" },
];

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
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human'), ($2, 's@x.test', 'Stranger', 'human')`,
    [USER, STRANGER]
  );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Brand', $2), ($3, 'Theirs', $4)`,
    [WS, USER, PRIVATE_WS, STRANGER]
  );

  await kind(VOICE, "brand-voice-guide", [
    { slug: "voice-status", lifecycle: true },
    { slug: "voice-context", label: "Context" },
    { slug: "voice-example-do", label: "Do" },
  ]);
  await kind(ANGLE, "outreach-angle", [
    { slug: "angle-status", lifecycle: true },
    { slug: "order" },
    { slug: "lead-with", label: "Lead with" },
  ]);
  await kind(POSITIONING, "positioning", [{ slug: "because" }]);

  const voice = (
    title: string,
    status: string,
    category: string,
    say: string,
    extra: Partial<Parameters<typeof entity>[0]> = {}
  ) =>
    entity({
      profileId: VOICE,
      type: "brand-voice-guide",
      title,
      status,
      category,
      properties: {
        "voice-status": status,
        "voice-context": "outreach",
        "voice-example-do": say,
      },
      ...extra,
    });
  await voice("Outreach voice", "approved", "done", SAID.approved, {
    id: APPROVED_VOICE,
  });
  await voice("Outreach voice v2", "draft", "open", SAID.draft, {
    id: DRAFT_VOICE,
  });
  await voice("Old voice", "deprecated", "lost", SAID.retired);
  await voice("Deleted voice", "approved", "done", SAID.deleted, {
    deleted: true,
  });
  await voice("Their voice", "approved", "done", SAID.private, {
    workspaceId: PRIVATE_WS,
    userId: STRANGER,
  });
  // A probe row (the listing rule): approved, but never a rule anyone set.
  const probe = await voice("Probe voice", "approved", "done", SAID.probe);
  await q(
    `update entities set system_data = '{"probe": true}'::jsonb where id = $1`,
    [probe]
  );
  await entity({
    profileId: VOICE,
    type: "brand-voice-guide",
    title: "Legal voice",
    status: "approved",
    category: "done",
    properties: {
      "voice-status": "approved",
      "voice-context": "legal",
      "voice-example-do": SAID.legal,
    },
  });
  for (const [title, order, lead] of [
    ["Default", 2, "A question about their week"],
    ["Posted on Malt", 1, "Their brief, in their words"],
  ] as const) {
    await entity({
      profileId: ANGLE,
      type: "outreach-angle",
      title,
      status: "approved",
      category: "done",
      properties: { "angle-status": "approved", order, "lead-with": lead },
    });
  }
  // A positioning exists, but the kind declares no lifecycle.
  await entity({
    profileId: POSITIONING,
    type: "positioning",
    title: "Automation for SMEs",
    status: null,
    category: null,
    properties: { because: "We ship in a week." },
  });

  await q(
    `insert into skills (id, user_id, slug, kind, scope, name, body, approved, status, created_at)
     values ($1, $4, 'creative-director', 'instruction', 'pod', 'Creative director', $5, true, 'active', now()),
            ($2, $4, 'agent-voice', 'instruction', 'pod', 'Agent voice', $6, false, 'active', now()),
            ($3, $4, 'old-manual', 'instruction', 'pod', 'Old manual', $7, true, 'inactive', now())`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      USER,
      SAID.skill,
      SAID.agentSkill,
      SAID.inactiveSkill,
    ]
  );
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, guidance, version, status, created_at, updated_at)
     values ($1, null, $2, 'Draft a first message', 'Draft it', 'is-agent',
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $3::jsonb, 1, 'active', now(), now())`,
    [PLAYBOOK, USER, JSON.stringify(GUIDANCE)]
  );
}, 120_000);

describe("loadPlaybookGuidance — only the current, approved version renders", () => {
  it("renders the approved voice, the ordered angles and the approved skill, in declared order", async () => {
    const { rendered } = await loadPlaybookGuidance(PLAYBOOK, { userId: USER });
    const t = rendered.text;
    expect(t.startsWith(GUIDANCE_HEADING)).toBe(true);
    expect(t).toContain("### Voice · Outreach voice (v1)");
    expect(t).toContain(`- Do: ${SAID.approved}`);
    // Declared order: voice, angles, skill.
    const at = (s: string) => t.indexOf(s);
    expect(at("### Voice")).toBeLessThan(at("### By kind of lead"));
    expect(at("### By kind of lead")).toBeLessThan(at(SAID.skill));
    // An ordered kind: by its `order`, with the rule sentence.
    expect(t).toContain(
      "1. Posted on Malt (v1)\n   - Lead with: Their brief, in their words\n2. Default (v1)"
    );
    // The lifecycle property and `order` are not rendered as rules.
    expect(t).not.toContain("voice-status");
    expect(t).not.toMatch(/Order: /);
    expect(rendered.used.map((u) => u.ref)).toEqual([
      "kind:brand-voice-guide",
      "kind:outreach-angle",
      "skill:creative-director",
    ]);
    expect(rendered.used[0]!.rows).toEqual([
      { id: APPROVED_VOICE, version: "1" },
    ]);
  });

  it("NEGATIVE: a draft, a retired, a deleted, an out-of-filter, a probe and an unreadable version never render", async () => {
    const { rendered } = await loadPlaybookGuidance(PLAYBOOK, { userId: USER });
    for (const never of [
      SAID.probe,
      SAID.draft,
      SAID.retired,
      SAID.deleted,
      SAID.legal,
      SAID.private,
    ]) {
      expect(rendered.text).not.toContain(never);
    }
  });

  it("NEGATIVE: an unapproved (agent-written) skill and an inactive one never render; they are named as not available", async () => {
    const { rendered } = await loadPlaybookGuidance(PLAYBOOK, { userId: USER });
    expect(rendered.text).not.toContain(SAID.agentSkill);
    expect(rendered.text).not.toContain(SAID.inactiveSkill);
    expect(rendered.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "skill:agent-voice",
          reason: "no approved skill named agent-voice",
        }),
        expect.objectContaining({
          ref: "skill:old-manual",
          reason: "no approved skill named old-manual",
        }),
        expect.objectContaining({
          ref: "kind:positioning",
          reason:
            "this kind declares no lifecycle, so no version of it is approved",
        }),
      ])
    );
    expect(rendered.text).not.toContain("We ship in a week.");
  });

  it("another reader sees only what THEY may read", async () => {
    const { rendered } = await loadPlaybookGuidance(PLAYBOOK, {
      userId: STRANGER,
    });
    expect(rendered.text).not.toContain(SAID.approved);
    expect(rendered.text).toContain(SAID.private);
  });

  it("a trial override renders the draft in place of the current version, and says which it replaced", async () => {
    const { rendered } = await loadPlaybookGuidance(
      PLAYBOOK,
      { userId: USER },
      { [APPROVED_VOICE]: DRAFT_VOICE }
    );
    expect(rendered.text).toContain(SAID.draft);
    expect(rendered.text).not.toContain(SAID.approved);
    expect(rendered.used[0]!.rows).toEqual([
      { id: DRAFT_VOICE, version: "1", replaces: APPROVED_VOICE },
    ]);
  });

  it("is stable: the same bytes and hash on every read", async () => {
    const a = await loadPlaybookGuidance(PLAYBOOK, { userId: USER });
    const b = await loadPlaybookGuidance(PLAYBOOK, { userId: USER });
    expect(b.rendered.text).toBe(a.rendered.text);
    expect(b.rendered.hash).toBe(a.rendered.hash);
  });
});

describe("every door renders the same section", () => {
  it("the MCP bind door and the IS kickoff carry the SAME rules section, and the run records what it used", async () => {
    const { rendered } = await loadPlaybookGuidance(PLAYBOOK, { userId: USER });

    const bound = await loadBoundPlaybookMethod({
      playbookId: PLAYBOOK,
      stageKey: null,
      stages: [],
      userId: USER,
    });
    if (bound.status !== "ok") throw new Error(bound.error);
    expect(bound.text).toBe(renderPlaybookMethod({ guidance: rendered.text }));

    const runId = randomUUID();
    await q(
      `insert into playbook_runs (id, playbook_id, executor, status, input, created_by, definition_snapshot)
       values ($1, $2, 'is-agent', 'running', '{}'::jsonb, $3, $4::jsonb)`,
      [
        runId,
        PLAYBOOK,
        USER,
        JSON.stringify({ version: 1, guidance: { declared: GUIDANCE } }),
      ]
    );
    h.kickoffs.length = 0;
    const res = await new IsAgentExecutor().run({
      workspaceId: WS,
      userId: USER,
      playbookId: PLAYBOOK,
      sessionId: randomUUID(),
      channelId: randomUUID(),
      goal: "Draft the first message to Jane.",
      capabilities: [],
      input: { runId },
    });
    expect(res.status).toBe("running");
    expect(h.kickoffs).toHaveLength(1);
    const kickoff = h.kickoffs[0]!;
    // The same section, byte for byte, BEFORE the goal.
    expect(kickoff).toContain(rendered.text);
    expect(kickoff.indexOf(GUIDANCE_HEADING)).toBeLessThan(
      kickoff.indexOf("Draft the first message to Jane.")
    );
    expect(kickoff).not.toContain(SAID.draft);

    const [run] = (
      await q<{ definition_snapshot: Record<string, any> }>(
        `select definition_snapshot from playbook_runs where id = $1`,
        [runId]
      )
    ).rows;
    expect(run!.definition_snapshot.version).toBe(1);
    expect(run!.definition_snapshot.guidance).toMatchObject({
      declared: GUIDANCE,
      status: "ok",
      hash: rendered.hash,
      used: rendered.used,
    });
  });
});

describe("a TRIAL run (the rule lab, slice 1b)", () => {
  it("renders the draft in place of the current version, says it is a trial, and records what it replaced", async () => {
    const sessionId = randomUUID();
    const channelId = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, channel_id, metadata, created_at, updated_at)
       values ($1, $2, 'Try the v2 voice', 'active', $3, $4::jsonb, now(), now())`,
      [
        sessionId,
        USER,
        channelId,
        JSON.stringify({
          trial: { guidanceOverride: { [APPROVED_VOICE]: DRAFT_VOICE } },
        }),
      ]
    );
    const runId = randomUUID();
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, definition_snapshot)
       values ($1, $2, $3, 'is-agent', 'running', '{}'::jsonb, $4, $5::jsonb)`,
      [
        runId,
        PLAYBOOK,
        sessionId,
        USER,
        JSON.stringify({ version: 1, guidance: { declared: GUIDANCE } }),
      ]
    );
    h.kickoffs.length = 0;
    const res = await new IsAgentExecutor().run({
      workspaceId: WS,
      userId: USER,
      playbookId: PLAYBOOK,
      sessionId,
      channelId,
      goal: "Draft the first message to Jane.",
      capabilities: [],
      input: { runId },
    });
    expect(res.status).toBe("running");
    const kickoff = h.kickoffs[0]!;
    expect(kickoff).toContain(SAID.draft);
    expect(kickoff).not.toContain(SAID.approved);
    expect(kickoff).toContain(TRIAL_KICKOFF_NOTE);

    const [run] = (
      await q<{ definition_snapshot: Record<string, any> }>(
        `select definition_snapshot from playbook_runs where id = $1`,
        [runId]
      )
    ).rows;
    expect(run!.definition_snapshot.guidance.used[0].rows).toEqual([
      { id: DRAFT_VOICE, version: "1", replaces: APPROVED_VOICE },
    ]);
  });

  it("NEGATIVE: the same run outside a trial renders the current version", async () => {
    h.kickoffs.length = 0;
    await new IsAgentExecutor().run({
      workspaceId: WS,
      userId: USER,
      playbookId: PLAYBOOK,
      sessionId: randomUUID(),
      channelId: randomUUID(),
      goal: "Draft the first message to Jane.",
      capabilities: [],
      input: {},
    });
    expect(h.kickoffs[0]).toContain(SAID.approved);
    expect(h.kickoffs[0]).not.toContain(TRIAL_KICKOFF_NOTE);
  });

  it("its drafted text is the agent's last reply in its room; null until it answers; no trial on another run", async () => {
    const channelId = randomUUID();
    const metadata = {
      trial: { guidanceOverride: { [APPROVED_VOICE]: DRAFT_VOICE } },
    };
    expect(await readTrialDraft({ metadata, channelId })).toEqual({
      guidanceOverride: { [APPROVED_VOICE]: DRAFT_VOICE },
      draftedText: null,
      draftedAt: null,
    });
    for (const [role, content, at] of [
      ["user", "kickoff", "2026-11-08T10:00:00Z"],
      ["assistant", "First try", "2026-11-08T10:01:00Z"],
      ["assistant", "Hi Jane, your Malt brief…", "2026-11-08T10:02:00Z"],
    ] as const) {
      await q(
        `insert into messages (id, channel_id, user_id, role, content, timestamp) values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), channelId, USER, role, content, at]
      );
    }
    expect(await readTrialDraft({ metadata, channelId })).toMatchObject({
      draftedText: "Hi Jane, your Malt brief…",
    });
    expect(await readTrialDraft({ metadata: {}, channelId })).toBeNull();
  });
});
