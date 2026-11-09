/**
 * A session START never offers a Goal template (a project-scope playbook is run
 * as a track with `synap_start_track`; it cannot bind to a session). The ONE
 * matcher honours `excludeGoalTemplates` (match-session-template.template-kind
 * test); this pins that `createFocusSession` actually PASSES it.
 *
 * Real: `createFocusSession` on PGlite. Stubbed: governance, room, realtime,
 * project placement (the create-session.derived-title harness) and
 * `matchSessionTemplate`, whose input is recorded.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  matchInputs: [] as Array<Record<string, unknown>>,
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

vi.mock("../match-session-template.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    matchSessionTemplate: async (input: Record<string, unknown>) => {
      h.matchInputs.push(input);
      return { candidates: [], optOut: "pass templateId: null" };
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

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

const start = () =>
  createFocusSession({
    userId: USER,
    goal: `Goal template exclusion ${randomUUID()}`,
    agentUserId: AGENT,
    matchTemplate: true,
    forceCreate: true,
  }) as Promise<Record<string, unknown>>;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'g@x.test', 'Agent', 'agent')`,
    [USER, AGENT]
  );
}, 120_000);

describe("createFocusSession — playbook suggestions at start", () => {
  it("asks the matcher to leave out Goal templates", async () => {
    h.matchInputs.length = 0;
    const res = await start();
    expect(res.status).toBe("created");
    expect(h.matchInputs).toHaveLength(1);
    expect(h.matchInputs[0]).toMatchObject({ excludeGoalTemplates: true });
  });
});
