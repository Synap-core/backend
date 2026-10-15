/**
 * "Who can take my work, and on which computer" — `readAgentsForHandoff`,
 * read back out of PGlite with every @synap/database table.
 *
 * Pinned:
 *   - an agent's computer is its `host_user_id` machine, and that beats the
 *     label on its key; an agent with no machine falls back to its last-seen
 *     key's `instance_label`; with neither, no computer;
 *   - machines are not agent rows; they are listed under `computers` — only
 *     YOURS (a teammate's "devbox" never answers "my devbox"), and a key
 *     label that carries one of your machines' names folds into it;
 *   - app agents are not listed;
 *   - paused is said, and a paused agent cannot take your work;
 *   - live: a pull agent inside `PULL_LIVE_WINDOW_MS`, not outside it; a
 *     dispatch agent only when its binding resolves;
 *   - handOff: what a hand-off FROM THE CALLING AGENT would do — the route's
 *     refusal ⇒ blocked; else the governance dry run for
 *     `focus_session.assign_agent` (no rule ⇒ proposes ⇒ asks_you); the
 *     caller itself and a person (no caller) ⇒ direct;
 *   - PARITY: for every row, `canTakeYourWork` is exactly what the real
 *     `route()` answers when a hand-off NAMES that agent for this person.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  PULL_LIVE_WINDOW_MS,
  readAgentsForHandoff,
  type HandoffAgent,
} from "../agents-for-handoff.js";
import { HAND_OFF_ACCEPT, route } from "../route.js";
import { AGENT_PENDING_PROPOSAL_CAP } from "../../../utils/permission-check.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const NOW = new Date("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const OWNER = randomUUID();
const TEAMMATE = randomUUID();
/** The owner's computer, renamed "devbox" by the owner. */
const DEVBOX = randomUUID();
/** A teammate's computer, also called "devbox". */
const THEIR_DEVBOX = randomUUID();
/** On DEVBOX, seen a minute ago — its key still says "MacBook" (minted there). */
const ON_DEVBOX = randomUUID();
/** No machine; its key says "MacBook-Pro"; seen two hours ago. */
const ON_LABEL = randomUUID();
/** No machine; its key label is "Devbox" — the person's devbox by name. */
const ON_LABEL_DEVBOX = randomUUID();
/** The owner's, live, but a person paused it. */
const PAUSED = randomUUID();
/** A teammate's pull agent (its key acts for the teammate). */
const THEIRS = randomUUID();
/** A teammate's agent on the teammate's devbox. */
const THEIRS_ON_DEVBOX = randomUUID();
/** The owner's house agent: the pod runs it; it never picks work up. */
const HOUSE = randomUUID();
/** The owner's agent bound for dispatch, binding healthy. */
const BOUND = randomUUID();
/** The owner's agent bound for dispatch to a tool that no longer exists. */
const BOUND_BROKEN = randomUUID();
/** An app's own agent — shown as its app, never here. */
const APP_AGENT = randomUUID();
/** A never-seen agent with no machine and no key. */
const NEVER = randomUUID();
const TOOL = randomUUID();
/** The owner's agent that would do the handing — already at its proposal limit. */
const CAPPED_CALLER = randomUUID();
/** A third person with two computers that share one name. */
const OWNER_B = randomUUID();
const LAPTOP_1 = randomUUID();
const LAPTOP_2 = randomUUID();

const BINDING = {
  protocol: "a2a",
  provider: "acme",
  supports: { push: false, inputRequired: true, cancel: false },
  verbs: { start: "acme_start_task", send: "acme_send_message" },
};

let roster: Awaited<ReturnType<typeof readAgentsForHandoff>>;
const row = (id: string): HandoffAgent => {
  const r = roster.agents.find((a) => a.agentUserId === id);
  if (!r) throw new Error(`no row for ${id}`);
  return r;
};

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@x.test', 'Owner', 'human'), ($2, 't@x.test', 'Teammate', 'human')`,
    [OWNER, TEAMMATE]
  );
  const agent = (
    id: string,
    owner: string,
    name: string,
    agentType: string | null,
    host: string | null = null
  ) =>
    q(
      `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id) values ($1, $2, $3, 'agent', $4, $5, $6)`,
      [id, `${id}@x.test`, name, agentType, owner, host]
    );
  await agent(DEVBOX, OWNER, "devbox", "machine");
  await agent(THEIR_DEVBOX, TEAMMATE, "devbox", "machine");
  await agent(ON_DEVBOX, OWNER, "Claude Code", "claude-code", DEVBOX);
  await agent(ON_LABEL, OWNER, "Claude Code (Mac)", "claude-code");
  await agent(ON_LABEL_DEVBOX, OWNER, "Codex", "codex");
  await agent(PAUSED, OWNER, "Cursor", "cursor");
  await agent(THEIRS, TEAMMATE, "Their Claude", "claude-code");
  await agent(
    THEIRS_ON_DEVBOX,
    TEAMMATE,
    "Their worker",
    "claude-code",
    THEIR_DEVBOX
  );
  await agent(HOUSE, OWNER, "Twin", "meta");
  await agent(BOUND, OWNER, "Acme agent", "acme");
  await agent(BOUND_BROKEN, OWNER, "Broken agent", "acme");
  await agent(APP_AGENT, OWNER, "Raycast", "raycast");
  await agent(NEVER, OWNER, "Fresh", null);
  await q(
    `update users set agent_paused_at = now(), agent_paused_by = $2 where id = $1`,
    [PAUSED, OWNER]
  );
  await q(
    `insert into apps (id, owner_user_id, name, agent_user_id) values ($1, $2, 'Raycast', $3)`,
    [randomUUID(), OWNER, APP_AGENT]
  );
  const key = (
    agentId: string,
    linkedTo: string,
    lastUsedAt: string | null,
    label: string | null
  ) =>
    q(
      `insert into api_keys (id, user_id, key_type, linked_user_id, is_active, last_used_at, instance_label, created_at)
       values ($1, $2, 'hub_inbound', $3, true, $4, $5, now())`,
      [randomUUID(), agentId, linkedTo, lastUsedAt, label]
    );
  await key(ON_DEVBOX, OWNER, ago(60_000), "MacBook");
  await key(ON_LABEL, OWNER, ago(2 * 3_600_000), "MacBook-Pro");
  await key(
    ON_LABEL_DEVBOX,
    OWNER,
    ago(PULL_LIVE_WINDOW_MS - 60_000),
    "Devbox"
  );
  await key(PAUSED, OWNER, ago(30_000), "MacBook-Pro");
  await key(THEIRS, TEAMMATE, ago(30_000), "their-laptop");
  await key(THEIRS_ON_DEVBOX, TEAMMATE, ago(30_000), null);
  await q(
    `insert into tools (id, workspace_id, created_by, name, kind, executor, config, status, approved, metadata, input_schema, capabilities)
     values ($1, null, $2, 'acme', 'external', 'external-agent', $3::jsonb, 'active', true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
    [TOOL, OWNER, JSON.stringify({ agentBinding: BINDING })]
  );
  const bind = (agentId: string, toolId: string) =>
    q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
      [randomUUID(), agentId, toolId]
    );
  await bind(BOUND, TOOL);
  await bind(BOUND_BROKEN, randomUUID());

  await q(
    `insert into users (id, email, name, user_type) values ($1, 'b@x.test', 'B', 'human')`,
    [OWNER_B]
  );
  await agent(LAPTOP_1, OWNER_B, "laptop", "machine");
  await agent(LAPTOP_2, OWNER_B, "laptop", "machine");

  await agent(CAPPED_CALLER, OWNER, "Busy Claude", "claude-code");
  // Never seen and no label, so it moves no computer count and no ranking.
  await key(CAPPED_CALLER, OWNER, null, null);
  // AGENT_PENDING_PROPOSAL_CAP pending proposals: the gate's limit is reached.
  for (let i = 0; i < AGENT_PENDING_PROPOSAL_CAP; i++) {
    await q(
      `insert into proposals (id, agent_user_id, status, created_at) values ($1, $2, 'pending', now())`,
      [randomUUID(), CAPPED_CALLER]
    );
  }

  roster = await readAgentsForHandoff(OWNER, { now: NOW });
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("readAgentsForHandoff — which computer", () => {
  it("the machine an agent runs on (host_user_id) names its computer, over its key's label", () => {
    expect(row(ON_DEVBOX).computer).toEqual({
      agentUserId: DEVBOX,
      name: "devbox",
    });
  });

  it("an agent with no machine falls back to its last-seen key's label", () => {
    expect(row(ON_LABEL).computer).toEqual({
      agentUserId: null,
      name: "MacBook-Pro",
    });
  });

  it("an agent with neither has no computer", () => {
    expect(row(NEVER).computer).toBeNull();
    expect(row(NEVER).lastSeenAt).toBeNull();
  });

  it("machines are not agent rows, app agents are not listed", () => {
    const ids = roster.agents.map((a) => a.agentUserId);
    expect(ids).not.toContain(DEVBOX);
    expect(ids).not.toContain(THEIR_DEVBOX);
    expect(ids).not.toContain(APP_AGENT);
    // Non-vacuity: the roster did read the other agents.
    expect(ids).toEqual(
      expect.arrayContaining([ON_DEVBOX, ON_LABEL, HOUSE, BOUND, THEIRS])
    );
  });

  it("computers are YOURS: your machine (with the label that names it folded in) and your agents' labels", () => {
    const byName = Object.fromEntries(
      roster.computers.map((c) => [c.name, c] as const)
    );
    // ON_DEVBOX (host) + ON_LABEL_DEVBOX (label "Devbox") — one devbox, yours.
    expect(byName.devbox).toEqual({
      agentUserId: DEVBOX,
      name: "devbox",
      agents: 2,
    });
    // ON_LABEL + PAUSED both last seen on "MacBook-Pro".
    expect(byName["MacBook-Pro"]).toEqual({
      agentUserId: null,
      name: "MacBook-Pro",
      agents: 2,
    });
    // The teammate's devbox and laptop never answer "my devbox".
    expect(roster.computers.map((c) => c.agentUserId)).not.toContain(
      THEIR_DEVBOX
    );
    expect(byName["their-laptop"]).toBeUndefined();
    expect(roster.computers).toHaveLength(2);
  });

  it("two of your computers with one name stay two (the person picks); others' labels never count", async () => {
    const b = await readAgentsForHandoff(OWNER_B, { now: NOW });
    expect(b.computers).toEqual(
      expect.arrayContaining([
        { agentUserId: LAPTOP_1, name: "laptop", agents: 0 },
        { agentUserId: LAPTOP_2, name: "laptop", agents: 0 },
      ])
    );
    // OWNER's agents are visible pod-wide, but their keys act for OWNER.
    expect(b.computers).toHaveLength(2);
  });

  it("a teammate's agent on the teammate's machine still names that machine on its own row", () => {
    expect(row(THEIRS_ON_DEVBOX).computer).toEqual({
      agentUserId: THEIR_DEVBOX,
      name: "devbox",
    });
  });
});

describe("readAgentsForHandoff — can it take your work, now", () => {
  it("paused is said, and a paused agent cannot take your work", () => {
    expect(row(PAUSED)).toMatchObject({
      paused: true,
      canTakeYourWork: false,
      whyNot: "paused",
      live: true,
    });
    expect(row(ON_DEVBOX)).toMatchObject({
      paused: false,
      canTakeYourWork: true,
      whyNot: null,
    });
  });

  it("a teammate's agent is not yours to hand work to; a house agent never picks work up", () => {
    expect(row(THEIRS)).toMatchObject({
      canTakeYourWork: false,
      whyNot: "not_owned",
    });
    expect(row(HOUSE)).toMatchObject({
      reach: "pod",
      canTakeYourWork: false,
      whyNot: "wrong_reach",
      live: true,
    });
  });

  it("pull is live inside the window and not outside it", () => {
    expect(row(ON_DEVBOX).live).toBe(true);
    expect(row(ON_LABEL_DEVBOX).live).toBe(true); // a minute inside the edge
    expect(row(ON_LABEL).live).toBe(false); // two hours
    expect(row(NEVER).live).toBe(false);
  });

  it("dispatch is live only when its binding resolves", () => {
    expect(row(BOUND)).toMatchObject({
      reach: "dispatch",
      live: true,
      canTakeYourWork: true,
    });
    expect(row(BOUND_BROKEN)).toMatchObject({ reach: "dispatch", live: false });
  });

  it("ready agents come first: can take it and live, then can take it, then the rest", () => {
    const rank = (a: HandoffAgent) =>
      a.canTakeYourWork ? (a.live ? 0 : 1) : 2;
    const ranks = roster.agents.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(roster.agents[0]!.agentUserId).toBe(ON_DEVBOX);
  });
});

describe("readAgentsForHandoff — what YOUR hand-off would do", () => {
  it("from an agent, with no rule: the gate proposes, so it asks you; the caller itself is direct; the route's refusal is blocked", async () => {
    const r = await readAgentsForHandoff(OWNER, {
      callerAgentUserId: ON_LABEL,
      now: NOW,
    });
    const by = (id: string) => r.agents.find((a) => a.agentUserId === id)!;
    expect(by(ON_DEVBOX)).toMatchObject({ handOff: "asks_you" });
    expect(by(ON_DEVBOX).handOffReason).toBeTruthy();
    expect(by(ON_LABEL)).toMatchObject({
      handOff: "direct",
      handOffReason: null,
    });
    expect(by(PAUSED)).toMatchObject({
      handOff: "blocked",
      handOffReason: expect.stringMatching(/^It is paused/),
    });
    expect(by(THEIRS)).toMatchObject({ handOff: "blocked" });
  });

  it("a calling agent at its proposal limit is BLOCKED, in the refusal's own words", async () => {
    const r = await readAgentsForHandoff(OWNER, {
      callerAgentUserId: CAPPED_CALLER,
      now: NOW,
    });
    const target = r.agents.find((a) => a.agentUserId === ON_DEVBOX)!;
    expect(target.handOff).toBe("blocked");
    expect(target.handOffReason).toMatch(
      new RegExp(
        `^Agent proposal limit reached \\(${AGENT_PENDING_PROPOSAL_CAP} pending\\)`
      )
    );
    expect(target.handOffReason).toMatch(/raise this limit/);
  });

  it("a person (no calling agent) staffs directly", () => {
    expect(row(ON_DEVBOX)).toMatchObject({
      handOff: "direct",
      handOffReason: null,
    });
    expect(row(PAUSED)).toMatchObject({ handOff: "blocked" });
  });
});

describe("readAgentsForHandoff — parity with the route", () => {
  it("canTakeYourWork === route() admits it when a hand-off NAMES it, for every row", async () => {
    // Non-vacuity: both answers occur, so a constant cannot pass.
    expect(roster.agents.some((a) => a.canTakeYourWork)).toBe(true);
    expect(roster.agents.some((a) => !a.canTakeYourWork)).toBe(true);
    for (const a of roster.agents) {
      const r = await route({
        ownerId: OWNER,
        accept: HAND_OFF_ACCEPT,
        selector: { agentUserId: a.agentUserId },
        pool: "owned",
      });
      expect({ id: a.agentUserId, admitted: r.kind === "routed" }).toEqual({
        id: a.agentUserId,
        admitted: a.canTakeYourWork,
      });
      expect(r.kind === "refused" ? r.reason : null).toBe(a.whyNot);
    }
  });
});
