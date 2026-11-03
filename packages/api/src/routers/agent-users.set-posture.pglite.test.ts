/**
 * `agentUsers.setPosture` — how an agent's writes land, set from pod admin's
 * agent page, on PGlite with the REAL router, the REAL posture writer
 * (`applyAgentPosture`) and the REAL reader (`agentUsers.governance`). Asserts
 * the stored rule rows and the read-back mode, never a return value alone: a
 * door that answered "updated" and wrote nothing is the defect.
 *
 * The gate is the Hub `PATCH /agent-users/:id/governance` door's: a person's
 * act (an agent credential is refused), the agent's creator or a pod admin.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        users: actual.users as never,
        workspaces: actual.workspaces as never,
        workspaceMembers: actual.workspaceMembers as never,
        apiKeys: actual.apiKeys as never,
        governanceRules: actual.governanceRules as never,
      },
    }),
  };
});
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({
  auditLog: async (opts: Record<string, unknown>) => {
    h.audits.push(opts);
    return null;
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  apiKeys,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  apps,
  governanceRules,
} from "@synap/database/schema";
import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";
import {
  classifyFloorEntry,
  resolveAgentPosture,
} from "@synap/governance-policy/postures";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\(.*\)/, "").replace(/\[\]$/, "");
    const type = BASIC.test(base) ? base : "text";
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const CREATOR = "user-creator";
const MEMBER = "user-member";
const ADMIN = "user-admin";
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const POD_ADMIN_WS = randomUUID();

function caller(
  userId: string,
  extra: { agentUserId?: string; keyType?: string } = {}
) {
  return agentUsersRouter.createCaller({
    authenticated: true,
    userId,
    ...extra,
  } as unknown as Context);
}

/** The agent's live pod-wide posture rules, by verdict. */
async function liveRules(agentUserId: string) {
  const r = await q<{ verdict: string; target_pattern: string }>(
    `select verdict, target_pattern from governance_rules
      where agent_user_id = $1 and revoked_at is null and scope_kind = 'pod'`,
    [agentUserId]
  );
  return r.rows;
}

async function storedPosture(agentUserId: string) {
  const r = await q<{ agent_metadata: Record<string, unknown> | null }>(
    `select agent_metadata from users where id = $1`,
    [agentUserId]
  );
  return r.rows[0]?.agent_metadata?.governancePosture ?? null;
}

beforeAll(async () => {
  for (const t of [
    users,
    apiKeys,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    // An app's own agent is governed by its app (PB4): the door reads it.
    apps,
    governanceRules,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  // The writer inserts rules without an id or a time: Postgres fills them.
  await h.client!.exec(
    `alter table governance_rules alter column id set default gen_random_uuid();
     alter table governance_rules alter column created_at set default now();`
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_metadata) values
       ($1, 'c@x', 'human', null, null), ($2, 'm@x', 'human', null, null),
       ($3, 'a@x', 'human', null, null),
       ($4, 'agent@x', 'agent', $1, '{"writesRequireProposal":true}'),
       ($5, 'agent2@x', 'agent', $2, '{"writesRequireProposal":true}')`,
    [CREATOR, MEMBER, ADMIN, AGENT, OTHER_AGENT]
  );
  await q(
    `insert into workspaces (id, name, system_slug) values ($1, 'Pod admin', 'pod-admin')`,
    [POD_ADMIN_WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'admin')`,
    [randomUUID(), POD_ADMIN_WS, ADMIN]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from governance_rules`);
  await q(
    `update users set agent_metadata = '{"writesRequireProposal":true}' where user_type = 'agent'`
  );
  h.audits.length = 0;
});

describe("agentUsers.setPosture — how an agent's writes land", () => {
  it("its creator sets create-with-undo: edits are stored as propose rules, creates are not, and the read says so", async () => {
    const res = await caller(CREATOR).setPosture({
      agentUserId: AGENT,
      posture: "create-with-undo",
    });
    expect(res).toEqual({ status: "updated", posture: "create-with-undo" });

    const rules = await liveRules(AGENT);
    expect(rules.length).toBeGreaterThan(0); // non-vacuity
    expect(rules.every((r) => r.verdict === "propose")).toBe(true);
    const patterns = rules.map((r) => r.target_pattern);
    // Exactly the preset the pod resolves: every edit asks, no create does.
    expect(new Set(patterns)).toEqual(
      new Set(resolveAgentPosture("create-with-undo").proposeFor)
    );
    expect(patterns.some((p) => classifyFloorEntry(p) === "create")).toBe(
      false
    );
    expect(await storedPosture(AGENT)).toBe("create-with-undo");

    const read = await caller(CREATOR).governance({ agentUserId: AGENT });
    expect(read).toMatchObject({
      writeMode: "create-with-undo",
      postures: { pod: "create-with-undo" },
    });
    expect(h.audits[0]).toMatchObject({
      subjectId: AGENT,
      userId: CREATOR,
      data: { posture: "create-with-undo" },
    });
  });

  it("a pod admin sets someone else's agent to ask first; creates ask too", async () => {
    await caller(ADMIN).setPosture({
      agentUserId: AGENT,
      posture: "ask-first",
    });
    const patterns = (await liveRules(AGENT)).map((r) => r.target_pattern);
    expect(new Set(patterns)).toEqual(
      new Set(resolveAgentPosture("ask-first").proposeFor)
    );
    expect(patterns.some((p) => classifyFloorEntry(p) === "create")).toBe(true);
    expect(
      await caller(ADMIN).governance({ agentUserId: AGENT })
    ).toMatchObject({ writeMode: "ask-first", askFirst: true });
  });

  it("null follows the pod default: the override rows are revoked and the marker dropped", async () => {
    await caller(CREATOR).setPosture({
      agentUserId: AGENT,
      posture: "create-with-undo",
    });
    await caller(CREATOR).setPosture({ agentUserId: AGENT, posture: null });
    expect(await liveRules(AGENT)).toEqual([]);
    expect(await storedPosture(AGENT)).toBeNull();
    expect(
      await caller(CREATOR).governance({ agentUserId: AGENT })
    ).toMatchObject({ postures: { pod: null } });
  });

  it("another member is refused and NOTHING is written", async () => {
    await expect(
      caller(MEMBER).setPosture({ agentUserId: AGENT, posture: "ask-first" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await liveRules(AGENT)).toEqual([]);
    expect(await storedPosture(AGENT)).toBeNull();
  });

  it("an agent credential is refused, even on its own row and even to tighten", async () => {
    for (const extra of [
      { agentUserId: AGENT },
      { agentUserId: OTHER_AGENT },
      { keyType: "is_internal" },
    ]) {
      await expect(
        caller(CREATOR, extra).setPosture({
          agentUserId: AGENT,
          posture: "ask-first",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await liveRules(AGENT)).toEqual([]);
  });

  it("an unknown agent is NOT_FOUND", async () => {
    for (const id of [randomUUID()]) {
      await expect(
        caller(ADMIN).setPosture({ agentUserId: id, posture: null })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("refuses a posture name the pod does not know", async () => {
    await expect(
      caller(CREATOR).setPosture({
        agentUserId: AGENT,
        posture: "act-freely" as never,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
