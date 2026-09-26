/**
 * `readSessionUsage` on PGlite — the REAL SQL of the "In this session" read
 * against tables generated from the Drizzle definitions.
 *
 * Fixture rows are chosen where naive rules DISAGREE:
 *   - a proposed→approved run whose OWN event also carries the session — a
 *     reader summing both ledgers counts it twice;
 *   - a REFUSED attempt on the same event kind, in the session — a reader
 *     filtering on `kind` alone counts a run that never happened;
 *   - a PENDING and a REJECTED proposal — neither ran;
 *   - the same skill run in ANOTHER session — the lens must track the argument;
 *   - a BUILTIN tool in the same capability container as a provider tool — a
 *     reader crediting "any member tool" reports a connector that is not one;
 *   - a skill that is only GRANTED — a reader merging grants into usage lists
 *     it as used.
 *
 * NOT covered, measured: index use (PGlite plans over a handful of rows), and
 * the PRODUCERS (that the doors stamp `session_id` is asserted elsewhere — the
 * fixtures write the columns directly).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  proposals,
  events,
  links,
  tools,
  skills,
  capabilities,
  playbooks,
  playbookRuns,
  users,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
} from "@synap/database/schema";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { readSessionUsage } from "../session-usage.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** DDL derived from the REAL Drizzle table config — never hand-written. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

const USER = "user-usage";
const OTHER_USER = "user-other";
const AGENT = randomUUID();
const SESSION = randomUUID();
const OTHER_SESSION = randomUUID();
const FOREIGN_SESSION = randomUUID(); // owned by OTHER_USER
const PLAYBOOK = randomUUID();

const SKILL_CAL = randomUUID(); // in container C with a provider tool
const SKILL_MAIL = randomUUID(); // declarative, provider_spec.tool = gmail
const SKILL_GRANTED_ONLY = randomUUID(); // granted, never run
const CONTAINER = randomUUID();
const TOOL_PROVIDER = randomUUID();
const TOOL_BUILTIN = randomUUID();

const CORR_APPROVED = randomUUID();

async function proposal(row: {
  skillId: string;
  sessionId: string;
  status: string;
  correlationId?: string | null;
  createdAt: string;
}) {
  await q(
    `insert into proposals (id, proposal_type, target_type, target_id, status,
       correlation_id, session_id, workspace_id, created_at, reviewed_at, data)
     values (gen_random_uuid(), 'capability.run', 'capability', $1, $2, $3, $4,
       null, $5, $5, $6::jsonb)`,
    [
      row.skillId,
      row.status,
      row.correlationId ?? null,
      row.sessionId,
      row.createdAt,
      JSON.stringify({ skillId: row.skillId, verbId: "verb.x" }),
    ]
  );
}

async function runEvent(row: {
  skillId: string;
  sessionId: string | null;
  timestamp: string;
  correlationId?: string;
  outcome?: string;
  userId?: string;
}) {
  await q(
    `insert into events (id, timestamp, subject_type, subject_id, type,
       user_id, correlation_id, session_id, data)
     values (gen_random_uuid(), $1, 'ai_decision', gen_random_uuid(),
       'ai_decision.completed', $2, $3, $4, $5::jsonb)`,
    [
      row.timestamp,
      row.userId ?? USER,
      row.correlationId ?? randomUUID(),
      row.sessionId,
      JSON.stringify({
        kind: "capability_run",
        skillId: row.skillId,
        verbId: "verb.x",
        ...(row.outcome ? { outcome: row.outcome } : {}),
      }),
    ]
  );
}

async function link(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  linkType: string
) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
    [fromType, fromId, toType, toId, linkType, t(0)]
  );
}

beforeAll(async () => {
  for (const tbl of [
    workspaces,
    workspaceMembers,
    focusSessions,
    proposals,
    events,
    links,
    tools,
    skills,
    capabilities,
    playbooks,
    playbookRuns,
    users,
    podMembers,
    projectMembers,
  ]) {
    await h.client!.exec(ddlFor(tbl as unknown as PgTable));
  }
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row (pod-wide globals, pod-visible
  // workspaces) — `podReaderWhere`. This fixture models provisioned users.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test'), ('${OTHER_USER}', '${OTHER_USER}@example.test')`
  );

  for (const [id, owner, playbookId, agentIds] of [
    [SESSION, USER, PLAYBOOK, `{${AGENT}}`],
    [OTHER_SESSION, USER, null, "{}"],
    [FOREIGN_SESSION, OTHER_USER, null, "{}"],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, goal, status, playbook_id, agent_ids, started_at, created_at, updated_at)
       values ($1, $2, 'g', 'active', $3, $4::text[], now(), now(), now())`,
      [id, owner, playbookId, agentIds]
    );
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Research agent', null, 'agent')`,
    [AGENT]
  );
  await q(
    `insert into playbooks (id, name, workspace_id) values ($1, 'Weekly review', null)`,
    [PLAYBOOK]
  );

  await q(
    `insert into skills (id, name, workspace_id, provider_spec) values
       ($1, 'calendar.list', null, null),
       ($2, 'mail.send', null, $4::jsonb),
       ($3, 'granted.only', null, null)`,
    [
      SKILL_CAL,
      SKILL_MAIL,
      SKILL_GRANTED_ONLY,
      JSON.stringify({ tool: "gmail", method: "POST", pathTemplate: "/x" }),
    ]
  );
  await q(
    `insert into capabilities (id, name, workspace_id) values ($1, 'Calendar', null)`,
    [CONTAINER]
  );
  await q(
    `insert into tools (id, name, kind, workspace_id, created_by, config, credential_ref) values
       ($1, 'Google Calendar connection', 'provider', null, $3, $4::jsonb, 'nango://google-calendar'),
       ($2, 'Calendar builtin', 'builtin', null, $3, '{}'::jsonb, null)`,
    [
      TOOL_PROVIDER,
      TOOL_BUILTIN,
      USER,
      JSON.stringify({ providerConfigKey: "google-calendar" }),
    ]
  );
  await link("skill", SKILL_CAL, "capability", CONTAINER, "member_of");
  await link("tool", TOOL_PROVIDER, "capability", CONTAINER, "member_of");
  await link("tool", TOOL_BUILTIN, "capability", CONTAINER, "member_of");

  // ── calendar.list: 1 approved proposal (+ its own event, same corr) + 2 direct ──
  await proposal({
    skillId: SKILL_CAL,
    sessionId: SESSION,
    status: "approved",
    correlationId: CORR_APPROVED,
    createdAt: t(1),
  });
  await runEvent({
    skillId: SKILL_CAL,
    sessionId: SESSION,
    correlationId: CORR_APPROVED,
    timestamp: t(1),
  });
  await runEvent({ skillId: SKILL_CAL, sessionId: SESSION, timestamp: t(2) });
  await runEvent({ skillId: SKILL_CAL, sessionId: SESSION, timestamp: t(5) });
  // never ran
  await proposal({
    skillId: SKILL_CAL,
    sessionId: SESSION,
    status: "pending",
    createdAt: t(6),
  });
  // another session
  await runEvent({
    skillId: SKILL_CAL,
    sessionId: OTHER_SESSION,
    timestamp: t(7),
  });
  // another user's event carrying this session id
  await runEvent({
    skillId: SKILL_CAL,
    sessionId: SESSION,
    timestamp: t(8),
    userId: OTHER_USER,
  });

  // ── mail.send: 1 direct + 1 refused ──
  await runEvent({ skillId: SKILL_MAIL, sessionId: SESSION, timestamp: t(3) });
  await runEvent({
    skillId: SKILL_MAIL,
    sessionId: SESSION,
    timestamp: t(9),
    outcome: "refused",
  });

  // ── granted.only: rejected proposal, and a grant ──
  await proposal({
    skillId: SKILL_GRANTED_ONLY,
    sessionId: SESSION,
    status: "rejected",
    createdAt: t(4),
  });
  await link("session", SESSION, "skill", SKILL_GRANTED_ONLY, "grants");
  await link("session", SESSION, "capability", CONTAINER, "grants");
  await link("session", SESSION, "tool", TOOL_PROVIDER, "used");
});

async function usage() {
  const result = await readSessionUsage({ userId: USER, sessionId: SESSION });
  expect(result).not.toBeNull();
  return result!;
}

describe("readSessionUsage", () => {
  it("counts runs PER SKILL across both ledgers (proposal + direct events)", async () => {
    const u = await usage();
    const cal = u.capabilities.find((c) => c.skillId === SKILL_CAL);
    expect(cal).toMatchObject({ name: "calendar.list", verb: "verb.x" });
    // 1 approved proposal + 2 direct events. Its own event dedupes; the pending
    // proposal, the other session's run and the other user's run do not count.
    expect(cal!.count).toBe(3);
    expect(cal!.lastUsedAt.toISOString()).toBe(t(5));
  });

  it("does NOT double count a proposed→approved run whose event also carries the session", async () => {
    const u = await usage();
    const cal = u.capabilities.find((c) => c.skillId === SKILL_CAL)!;
    // The discriminating row: CORR_APPROVED exists as BOTH a proposal and an
    // event in this session. Summing ledgers would read 4.
    expect(cal.count).not.toBe(4);
    expect(cal.count).toBe(3);
  });

  it("EXCLUDES a refused attempt, a pending and a rejected proposal", async () => {
    const u = await usage();
    const mail = u.capabilities.find((c) => c.skillId === SKILL_MAIL);
    expect(mail!.count).toBe(1);
    expect(mail!.lastUsedAt.toISOString()).toBe(t(3));
    expect(u.capabilities.map((c) => c.skillId)).not.toContain(
      SKILL_GRANTED_ONLY
    );
    expect(u.capabilities.map((c) => c.skillId).sort()).toEqual(
      [SKILL_CAL, SKILL_MAIL].sort()
    );
  });

  it("DERIVES connectors: the container's provider tool (never its builtin), else provider_spec", async () => {
    const u = await usage();
    expect(u.connectors.map((c) => c.id).sort()).toEqual(
      [TOOL_PROVIDER, "gmail"].sort()
    );
    const cal = u.connectors.find((c) => c.id === TOOL_PROVIDER)!;
    expect(cal).toMatchObject({
      toolId: TOOL_PROVIDER,
      serviceId: "google-calendar",
      name: resolveServiceName("google-calendar"),
      count: 3,
      via: {
        kind: "capability",
        capabilityId: CONTAINER,
        capabilityName: "Calendar",
      },
    });
    const mail = u.connectors.find((c) => c.id === "gmail")!;
    expect(mail).toMatchObject({
      toolId: null,
      serviceId: "gmail",
      count: 1,
      via: { kind: "provider_spec", skillId: SKILL_MAIL },
    });
  });

  it("keeps GRANTS separate from usage, and `used` edges as recorded provenance", async () => {
    const u = await usage();
    expect(u.granted.map((g) => `${g.kind}:${g.id}:${g.name}`).sort()).toEqual(
      [
        `skill:${SKILL_GRANTED_ONLY}:granted.only`,
        `capability:${CONTAINER}:Calendar`,
      ].sort()
    );
    expect(u.recorded).toEqual([
      expect.objectContaining({
        kind: "tool",
        id: TOOL_PROVIDER,
        name: "Google Calendar connection",
      }),
    ]);
  });

  it("names the playbook and the agents staffed on the session", async () => {
    const u = await usage();
    expect(u.playbook).toEqual({ id: PLAYBOOK, name: "Weekly review" });
    expect(u.agents).toEqual([{ id: AGENT, name: "Research agent" }]);
  });

  it("tracks the ARGUMENT: the other session sees only its own run", async () => {
    const u = await readSessionUsage({
      userId: USER,
      sessionId: OTHER_SESSION,
    });
    expect(u!.capabilities).toEqual([
      expect.objectContaining({ skillId: SKILL_CAL, count: 1 }),
    ]);
    expect(u!.granted).toEqual([]);
    expect(u!.playbook).toBeNull();
  });

  it("another user's session is NOT FOUND (null), not an empty usage", async () => {
    await expect(
      readSessionUsage({ userId: USER, sessionId: FOREIGN_SESSION })
    ).resolves.toBeNull();
    // Non-vacuity: the row exists and its owner can read it.
    await expect(
      readSessionUsage({ userId: OTHER_USER, sessionId: FOREIGN_SESSION })
    ).resolves.not.toBeNull();
  });

  it("a FAILED read throws — it never folds into an empty block", async () => {
    await h.client!.exec(`alter table events rename to events_gone`);
    try {
      await expect(
        readSessionUsage({ userId: USER, sessionId: SESSION })
      ).rejects.toThrow();
    } finally {
      await h.client!.exec(`alter table events_gone rename to events`);
    }
    // And the fixture is intact again.
    expect((await usage()).capabilities).toHaveLength(2);
  });
});
