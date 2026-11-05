/**
 * Self-healing agent → template links (founder decision D10), on PGlite
 * through the real pieces: `selfHealAgentTemplateLinks` (link the clear ones,
 * ONE card per person for the rest, kept current, never a second), and
 * `applyAgentTemplateAnswer` (the card's answer links; "None of these" is
 * remembered and never asked again; only the agent's own person answers).
 *
 * Rows that rule out a wrong rule: the pod's own agent (reach pod), a
 * computer, an agent already linked and one marked "none" are never asked;
 * with no template installed nobody is asked at all.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  createdSessions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
// The session door's own suites own what a start does; here: WHICH person's
// card session is opened, and that it is opened once.
vi.mock("../focus-sessions/create-session.js", () => ({
  createFocusSession: async (p: Record<string, unknown>) => {
    h.createdSessions.push(p);
    const id = randomUUID();
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
       values ($1, $2, $3, $4, 'active', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
      [id, p.userId, p.goal, p.title]
    );
    return { status: "created", session: { id } };
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
  agentTemplates,
  apiKeys,
  apps,
  focusSessions,
  links,
  users,
} from "@synap/database/schema";
import { installAgentTemplate } from "./install.js";
import {
  AGENT_TEMPLATE_ASK_SLOT_KIND,
  AGENT_TEMPLATE_NONE_OPTION,
  applyAgentTemplateAnswer,
  selfHealAgentTemplateLinks,
} from "./self-heal.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : c.name === "aliases"
            ? ` default '[]'::jsonb`
            : c.name === "metadata"
              ? ` default '{}'::jsonb`
              : c.name === "practices"
                ? ` default '{"skills":[]}'::jsonb`
                : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const OTHER = randomUUID();

/** An agent the person connected (it owns a key: reach pull). */
async function agent(
  agentType: string,
  name: string,
  over: {
    owner?: string;
    keyless?: boolean;
    link?: string;
    none?: boolean;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, name, user_type, created_by_user_id, agent_type, agent_template_slug, agent_metadata)
     values ($1, $2, $3, 'agent', $4, $5, $6, $7::jsonb)`,
    [
      id,
      `${id}@x`,
      name,
      over.owner ?? OWNER,
      agentType,
      over.link ?? null,
      JSON.stringify(over.none ? { templateNone: true } : {}),
    ]
  );
  if (!over.keyless)
    await q(
      `insert into api_keys (id, user_id, is_active, key_type, key_name, key_prefix, key_hash, scope)
       values ($1, $2, true, 'hub_inbound', 'k', 'synap_', 'h', '{}')`,
      [randomUUID(), id]
    );
  return id;
}
const linkOf = async (id: string) =>
  (
    await q<{ s: string | null }>(
      `select agent_template_slug as s from users where id = $1`,
      [id]
    )
  ).rows[0]!.s;
const cards = async (owner = OWNER) =>
  (
    await q<{ id: string; expected_outputs: Array<Record<string, any>> }>(
      `select id, expected_outputs from focus_sessions where user_id = $1`,
      [owner]
    )
  ).rows;
const openCardFields = async (owner = OWNER) => {
  const all = (await cards(owner)).flatMap((s) =>
    s.expected_outputs.filter(
      (o) =>
        o.kind === AGENT_TEMPLATE_ASK_SLOT_KIND && !o.answer && !o.retiredAt
    )
  );
  return all.map((o) =>
    (o.ask.form.fields as Array<{ key: string }>).map((f) => f.key).sort()
  );
};

const DEF = (harness: string, worker = false) => ({
  agent: {
    harness,
    worker,
    tried: true,
    ...(worker ? { wake: { program: harness, args: [] } } : {}),
  },
});

beforeAll(async () => {
  for (const t of [agentTemplates, apiKeys, apps, focusSessions, links, users])
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create unique index if not exists agent_templates_slug_unique on agent_templates (slug)`
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from agent_templates; delete from api_keys; delete from focus_sessions; delete from users;`
  );
  h.createdSessions.length = 0;
});

async function installOfficial() {
  for (const [slug, name, worker] of [
    ["claude-code", "Claude Code", true],
    ["hermes", "Hermes Agent", true],
    ["codex", "Codex", true],
  ] as const)
    await installAgentTemplate({
      slug,
      packageSlug: slug,
      packageVersion: null,
      name,
      definition: DEF(slug, worker),
    });
}

describe("D10 — clear matches link, the rest is asked ONCE", () => {
  it("links the clear ones and files ONE card for the rest; the pod's own agents, computers, linked and 'none' agents are never asked", async () => {
    await installOfficial();
    const devbox = await agent("claude-code-devbox", "Claude-code-devbox");
    const hermes = await agent("hermes", "Hermes");
    const eve = await agent("eve", "Eve");
    const coder = await agent("coder", "Coder");
    await agent("planner", "Planner", { keyless: true }); // reach pod
    await agent("machine", "devbox"); // a computer
    const linked = await agent("codex", "Codex", { link: "codex" });
    await agent("feynman", "Feynman", { none: true });

    const report = await selfHealAgentTemplateLinks();
    expect(
      Object.fromEntries(
        report.linked.map((l) => [l.agentUserId, [l.slug, l.rule]])
      )
    ).toEqual({
      [devbox]: ["claude-code", "type_prefix"],
      [hermes]: ["hermes", "type"],
    });
    expect(await linkOf(devbox)).toBe("claude-code");
    expect(await linkOf(linked)).toBe("codex");
    expect(h.createdSessions).toHaveLength(1);
    expect(h.createdSessions[0]).toMatchObject({ userId: OWNER });
    expect(await openCardFields()).toEqual([[eve, coder].sort()]);
  });

  it("a second pass files no second card; a later pass keeps the ONE card current", async () => {
    await installOfficial();
    const eve = await agent("eve", "Eve");
    const coder = await agent("coder", "Coder");
    await selfHealAgentTemplateLinks();
    await selfHealAgentTemplateLinks();
    expect(h.createdSessions).toHaveLength(1);
    expect(await openCardFields()).toEqual([[eve, coder].sort()]);

    await q(`update users set agent_template_slug = 'codex' where id = $1`, [
      coder,
    ]);
    const deepseek = await agent("deepseek", "Deepseek");
    await selfHealAgentTemplateLinks();
    expect(h.createdSessions).toHaveLength(1);
    expect(await openCardFields()).toEqual([[eve, deepseek].sort()]);
  });

  it("each person gets their own card, about their own agents", async () => {
    await installOfficial();
    const mine = await agent("eve", "Eve");
    const theirs = await agent("coder", "Coder", { owner: OTHER });
    await selfHealAgentTemplateLinks();
    expect(await openCardFields(OWNER)).toEqual([[mine]]);
    expect(await openCardFields(OTHER)).toEqual([[theirs]]);
  });

  it("with no template installed, nobody is linked or asked", async () => {
    await agent("eve", "Eve");
    const report = await selfHealAgentTemplateLinks();
    expect(report.skipped).toBe(true);
    expect(h.createdSessions).toHaveLength(0);
  });
});

describe("D10 — the answer", () => {
  it("links each agent to the program picked; 'None of these' is remembered and never asked again; another person's answer is ignored", async () => {
    await installOfficial();
    const eve = await agent("eve", "Eve");
    const coder = await agent("coder", "Coder");
    const theirs = await agent("openclaw", "Openclaw", { owner: OTHER });
    await selfHealAgentTemplateLinks();

    const out = await applyAgentTemplateAnswer({
      answeredBy: OWNER,
      values: {
        [eve]: "Hermes Agent",
        [coder]: AGENT_TEMPLATE_NONE_OPTION,
        [theirs]: "Codex",
      },
    });
    expect(out).toEqual({ linked: [eve], none: [coder], ignored: [theirs] });
    expect(await linkOf(eve)).toBe("hermes");
    expect(await linkOf(coder)).toBeNull();
    expect(await linkOf(theirs)).toBeNull();

    // Next pass: the person's card has nothing left to ask — it is retired,
    // and the "none" agent is not asked again.
    await selfHealAgentTemplateLinks();
    expect(await openCardFields(OWNER)).toEqual([]);
  });
});
