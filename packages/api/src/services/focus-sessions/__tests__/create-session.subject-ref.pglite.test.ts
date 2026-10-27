/**
 * W2 door 1 (founder decision 2 A): MCP `synap_start_session` names the
 * subject by an identity (`subjectRef`) or offers same-name candidates — and
 * never attaches a weak match, never creates.
 *
 *   - a strong `externalId` the caller can see → that entity is the subject;
 *   - the same identity owned by an entity the caller CANNOT see reads exactly
 *     like no match (`unresolved`, its id nowhere in the reply): no oracle;
 *   - an unknown ref starts with no subject and says `unresolved`;
 *   - `subjectEntityId` + `subjectRef` together is refused in words;
 *   - a title that matches an entity by name only is OFFERED as a candidate
 *     (kinds that declare a lifecycle; the caller's own rows), never attached.
 *
 * Real: the MCP handler, `createFocusSession`, `resolveIdentity`,
 * `isOutputRefVisible`, `getEffectiveLifecycles`, on PGlite with every table.
 * Stubbed: governance (granted), the room mint, realtime, project placement,
 * spawn links.
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
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, { schema });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
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

const { sessionHandlers } =
  await import("../../../routers/mcp/handlers/session.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const THEIR_SPACE = "44444444-4444-4444-8444-444444444444";
const MY_ISSUE = "55555555-5555-4555-8555-555555555555";
const THEIR_ISSUE = "66666666-6666-4666-8666-666666666666";
const MY_NOTE = "77777777-7777-4777-8777-777777777777";
const MY_PROBE_ISSUE = "88888888-8888-4888-8888-888888888888";
const ISSUE_KIND = "d0000000-0000-4000-8000-000000000001";
const NOTE_KIND = "d0000000-0000-4000-8000-000000000002";
const STATUS_DEF = "d0000000-0000-4000-8000-000000000003";
const MY_REF = "github:synap-core/backend#901";
const THEIR_REF = "github:synap-core/backend#902";

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

const stored = async (goal: string) =>
  (
    await q<{ subject_entity_id: string | null }>(
      `select subject_entity_id from focus_sessions where goal = $1`,
      [goal]
    )
  ).rows;

const mcpStart = async (args: Record<string, unknown>) => {
  const res = await sessionHandlers.synap_start_session!({
    toolName: "synap_start_session",
    args: { matchTemplate: false, forceCreate: true, ...args },
    userId: USER,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  return { text, body: JSON.parse(text) as Record<string, unknown> };
};

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'r@x.test', 'Claude Code', 'agent'),
      ($3, 's@x.test', 'Stranger', 'human')`,
    [USER, AGENT, STRANGER]
  );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Theirs', $2)`,
    [THEIR_SPACE, STRANGER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), THEIR_SPACE, STRANGER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'issue', 'Issue', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($2, 'note', 'Note', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [ISSUE_KIND, NOTE_KIND]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open", category: "open" },
          { key: "closed", label: "Closed", category: "done" },
        ],
      }),
    ]
  );
  // Only the issue kind DECLARES a lifecycle.
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [ISSUE_KIND, STATUS_DEF]
  );
  // Same title on all three: two of mine (an issue, a note) and the stranger's
  // issue in a space I am not in.
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, created_at, updated_at) values
      ($1, $2, null, $3, 'issue', 'Flaky login test', '{}'::jsonb, now(), now()),
      ($4, $2, null, $5, 'note', 'Flaky login test', '{}'::jsonb, now(), now()),
      ($6, $7, $8, $3, 'issue', 'Flaky login test', '{}'::jsonb, now(), now())`,
    [
      MY_ISSUE,
      USER,
      ISSUE_KIND,
      MY_NOTE,
      NOTE_KIND,
      THEIR_ISSUE,
      STRANGER,
      THEIR_SPACE,
    ]
  );
  // A probe row (D8) of mine, same title and kind: the listing rule keeps it
  // out of every listing, candidates included.
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, created_at, updated_at) values
      ($1, $2, null, $3, 'issue', 'Flaky login test', '{}'::jsonb, '{"probe":true}'::jsonb, now(), now())`,
    [MY_PROBE_ISSUE, USER, ISSUE_KIND]
  );
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source, created_at) values
      ($1, $2, 'external_id', $3, 'test', now()),
      ($4, $5, 'external_id', $6, 'test', now())`,
    [randomUUID(), MY_ISSUE, MY_REF, randomUUID(), THEIR_ISSUE, THEIR_REF]
  );
}, 120_000);

describe("synap_start_session — subjectRef", () => {
  it("a strong externalId the caller can see becomes the subject", async () => {
    const goal = `Ref mine ${randomUUID()}`;
    const { body } = await mcpStart({
      goal,
      subjectRef: { externalId: MY_REF },
    });
    expect(body.status).toBe("created");
    expect(body.subjectRef).toEqual({ status: "resolved", entityId: MY_ISSUE });
    expect(await stored(goal)).toEqual([{ subject_entity_id: MY_ISSUE }]);
  });

  it("an identity owned by an entity the caller cannot see reads as unresolved — its id is nowhere in the reply", async () => {
    const goal = `Ref theirs ${randomUUID()}`;
    const { body, text } = await mcpStart({
      goal,
      subjectRef: { externalId: THEIR_REF },
    });
    expect(body.subjectRef).toEqual({
      status: "unresolved",
      tried: ["externalId"],
    });
    expect(text).not.toContain(THEIR_ISSUE);
    expect(text).not.toContain(MY_PROBE_ISSUE);
    expect(await stored(goal)).toEqual([{ subject_entity_id: null }]);
  });

  it("an unknown ref starts with no subject and says so", async () => {
    const goal = `Ref unknown ${randomUUID()}`;
    const { body } = await mcpStart({
      goal,
      subjectRef: { url: "https://github.com/synap-core/backend/pull/1" },
    });
    expect(body.status).toBe("created");
    expect(body.subjectRef).toEqual({ status: "unresolved", tried: ["url"] });
    expect(await stored(goal)).toEqual([{ subject_entity_id: null }]);
  });

  it("subjectEntityId and subjectRef together are refused, nothing stored", async () => {
    const goal = `Ref both ${randomUUID()}`;
    await expect(
      mcpStart({
        goal,
        subjectEntityId: MY_ISSUE,
        subjectRef: { externalId: MY_REF },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await stored(goal)).toEqual([]);
  });

  it("a malformed subjectRef is refused in words", async () => {
    const { body } = await mcpStart({
      goal: `Ref bad ${randomUUID()}`,
      subjectRef: "github:x#1",
    });
    expect(String(body.error)).toMatch(/subjectRef must be an object/);
  });
});

describe("synap_start_session — subjectCandidates", () => {
  it("a same-name entity is OFFERED, never attached: my issue only (not my note, not the stranger's issue, not my probe row)", async () => {
    const goal = `Weak ${randomUUID()}`;
    const { body, text } = await mcpStart({ goal, title: "Flaky login test" });
    expect(body.status).toBe("created");
    expect(body.subjectCandidates).toEqual([
      { id: MY_ISSUE, kind: "issue", title: "Flaky login test" },
    ]);
    expect(text).not.toContain(THEIR_ISSUE);
    expect(text).not.toContain(MY_PROBE_ISSUE);
    expect(await stored(goal)).toEqual([{ subject_entity_id: null }]);
  });

  it("a session that names its subject gets no candidates", async () => {
    const { body } = await mcpStart({
      goal: `Named ${randomUUID()}`,
      title: "Flaky login test",
      subjectEntityId: MY_ISSUE,
    });
    expect(body.subjectCandidates).toBeUndefined();
  });
});
