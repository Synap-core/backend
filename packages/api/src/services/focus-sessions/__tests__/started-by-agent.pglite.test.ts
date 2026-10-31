/**
 * "Which agent started this session" is stamped by the CREATE door and read
 * by orient's `handedToYou` (plan v2 S8): a session an agent starts is never
 * listed as handed to it, while one a person (or another agent) hands it is,
 * through the real doors — `createFocusSession`, the roster append
 * (`attachSessionAgent`, what `addAgentId` and an approved hand-off apply),
 * and `buildStartHere`.
 *
 * Asserted:
 *   - the agent's own start: stamped, never listed, and still not listed after
 *     the person adds it to the roster again (an append writes no stamp);
 *   - a person's start handed to the agent (named at start, or added later)
 *     and another agent's start handed to it: listed;
 *   - a row from before the stamp (the stamp removed) started through one of
 *     the agent's keys: still not listed, by its client key.
 *
 * Real: `createFocusSession`, `attachSessionAgent`, `buildStartHere` on PGlite
 * with every @synap/database table. Stubbed: governance (granted), the session
 * room, realtime, project placement, the spawn edge.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

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
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";
import { attachSessionAgent } from "../attach-session-agent.js";
import { buildStartHere } from "../../discover/start-here.js";

const USER = "11111111-1111-4111-8111-111111111111";
/** Interactive Claude Code and its worker: ONE identity. */
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const AGENT_KEY = "44444444-4444-4444-8444-444444444444";

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

const sessionId = (r: unknown) => {
  const id = (r as { session?: { id: string } }).session?.id;
  if (!id) throw new Error(`no session created: ${JSON.stringify(r)}`);
  return id;
};

const start = async (p: {
  agentUserId?: string;
  agentIds?: string[];
  clientKey?: string;
}) =>
  sessionId(
    await createFocusSession({
      userId: USER,
      goal: `Work ${randomUUID()}`,
      matchTemplate: false,
      forceCreate: true,
      ...p,
    })
  );

const handedTo = async (agentUserId: string) => {
  const s = await buildStartHere({
    caller: {} as never,
    userId: USER,
    agentUserId,
    pending: { status: "unavailable" },
    learnMoreSkill: "system/synap/concepts",
  });
  return (s.handedToYou as { items: Array<{ id: string }> }).items.map(
    (i) => i.id
  );
};

const stamp = async (id: string) =>
  (
    await h.client!.query<{ s: string | null }>(
      `select metadata->>'startedByAgentId' as s from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]?.s ?? null;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'cc@x.test', 'Claude Code', 'agent'),
      ($3, 'cx@x.test', 'Codex', 'agent')`,
    [USER, AGENT, OTHER_AGENT]
  );
  // Both agents act for USER (their keys are linked to them): THE route lets
  // work be handed to them.
  await h.client!.query(
    `insert into api_keys (id, user_id, key_type, linked_user_id, is_active) values
      ($1, $2, 'hub_inbound', $4, true), ($3, $5, 'hub_inbound', $4, true)`,
    [AGENT_KEY, AGENT, randomUUID(), USER, OTHER_AGENT]
  );
}, 180_000);

describe("handedToYou and the agent that started the session", () => {
  it("the agent's own start is stamped and never listed, even after the person re-adds it", async () => {
    const own = await start({ agentUserId: AGENT });
    expect(await stamp(own)).toBe(AGENT);
    expect(await handedTo(AGENT)).not.toContain(own);

    const attached = await attachSessionAgent({
      sessionId: own,
      agentId: AGENT,
      userId: USER,
    });
    expect(attached.status).toBe("attached");
    expect(await stamp(own)).toBe(AGENT);
    expect(await handedTo(AGENT)).not.toContain(own);
  });

  it("work a person hands it — named at start, or added later — is listed", async () => {
    const named = await start({ agentIds: [AGENT] });
    const added = await start({});
    await attachSessionAgent({
      sessionId: added,
      agentId: AGENT,
      userId: USER,
    });
    expect(await stamp(named)).toBeNull();
    expect(await stamp(added)).toBeNull();
    const listed = await handedTo(AGENT);
    expect(listed).toContain(named);
    expect(listed).toContain(added);
  });

  it("another agent's start handed to it is listed for it, not for the starter", async () => {
    const handed = await start({
      agentUserId: OTHER_AGENT,
      agentIds: [AGENT],
    });
    expect(await stamp(handed)).toBe(OTHER_AGENT);
    expect(await handedTo(AGENT)).toContain(handed);
    expect(await handedTo(OTHER_AGENT)).not.toContain(handed);
  });

  it("a row from before the stamp, started through the agent's key, is still not listed", async () => {
    const legacy = await start({
      agentUserId: AGENT,
      clientKey: `key:${AGENT_KEY}|conv:claude-code:${randomUUID()}`,
    });
    await h.client!.query(
      `update focus_sessions set metadata = metadata - 'startedByAgentId' where id = $1`,
      [legacy]
    );
    expect(await stamp(legacy)).toBeNull();
    expect(await handedTo(AGENT)).not.toContain(legacy);
    // CONTROL: the same legacy row handed by a person (no client key) is listed.
    const legacyHanded = await start({ agentIds: [AGENT] });
    expect(await handedTo(AGENT)).toContain(legacyHanded);
  });
});
