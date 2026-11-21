/**
 * Removing an agent pauses what it wrote. `automations.agent_user_id` is
 * ON DELETE SET NULL (0442), and an automation with no actor is governed as
 * its person: without the pause, a deleted agent's automations would keep
 * running with nobody's ladder judging their writes.
 *
 * Real: `agentUsers.remove`, `pauseAutomationsOfAgents`, the FK (declared
 * here as 0442 declares it). Stubbed: the manage-permission check, audit.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
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
  return {
    ...actual,
    db: drizzle(client, { schema }),
    verifyPermission: async () => ({ allowed: true }),
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
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));

import { users, workspaceMembers, automations } from "@synap/database/schema";
import { AUTOMATION_AGENT_REMOVED } from "@synap/database";
import { pgliteSchemaDdl } from "../__tests__/pglite-ddl.js";
import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-1";
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const WS = randomUUID();

async function automation(actor: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, agent_user_id, name, trigger_type, status)
     values ($1, $2, $3, $4, $5, 'cron', 'active')`,
    [id, WS, PERSON, actor, `a-${id}`]
  );
  return id;
}
const row = async (id: string) =>
  (
    await q<{
      status: string;
      agent_user_id: string | null;
      error_message: string | null;
    }>(
      `select status, agent_user_id, error_message from automations where id = $1`,
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([users, workspaceMembers, automations]));
  // 0442's foreign key: deleting the agent nulls the actor.
  await h.client!.exec(
    `alter table automations add foreign key (agent_user_id) references users(id) on delete set null;`
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values
      ($1, 'p@x.test', 'human', null),
      ($2, 'a@x.test', 'agent', $1),
      ($3, 'o@x.test', 'agent', $1)`,
    [PERSON, AGENT, OTHER_AGENT]
  );
}, 60_000);

describe("removing an agent pauses the automations it wrote", () => {
  it("its automation is paused with the reason; the person's and another agent's keep running", async () => {
    const its = await automation(AGENT);
    const persons = await automation(null);
    const others = await automation(OTHER_AGENT);

    await agentUsersRouter
      .createCaller({
        authenticated: true,
        userId: PERSON,
      } as unknown as Context)
      .remove({ workspaceId: WS, agentUserId: AGENT });

    expect(await row(its)).toEqual({
      status: "paused",
      agent_user_id: null,
      error_message: AUTOMATION_AGENT_REMOVED,
    });
    expect((await row(persons)).status).toBe("active");
    expect(await row(others)).toMatchObject({
      status: "active",
      agent_user_id: OTHER_AGENT,
    });
  });
});
