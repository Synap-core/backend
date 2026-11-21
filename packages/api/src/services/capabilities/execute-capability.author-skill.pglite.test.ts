/**
 * An automation runs as its owner (the person). A skill its agent made is the
 * person's (`skills.user_id` = the person, `agent_user_id` = the agent: the
 * skill doors and 0445 stamp it so), so a step finds it through the person's
 * own lens; the run's agent widens nothing.
 *
 * Real: the skill lookup (`answeringSkillsWhere` → `visibleSkillsWhere`) on
 * PGlite. Stubbed: the gate, which answers `deny` so the test stops once the
 * skill was FOUND (a missing skill answers `not_found` before the gate).
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
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "deny",
    reason: "reached the gate",
  }),
  CAPABILITY_RUN_PROPOSAL: {
    targetType: "capability",
    proposalType: "capability.run",
  },
}));

import { skills } from "@synap/database/schema";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";

const { executeCapability } = await import("./execute-capability.js");

const PERSON = "person-1";
const AGENT = "agent-1";
const ORPHAN = "agent-orphan";
const VERB = "digest_my_inbox";
const ORPHAN_VERB = "orphan_digest";

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([skills]));
  await h.client!.query(
    `insert into skills (id, name, kind, scope, user_id, agent_user_id, status, approved)
     values ($1, $2, 'code', 'user', $3, $4, 'active', true)`,
    [randomUUID(), VERB, PERSON, AGENT]
  );
  // A row another user still owns (an agent's, on a pod with no owner).
  await h.client!.query(
    `insert into skills (id, name, kind, scope, user_id, agent_user_id, status, approved)
     values ($1, $2, 'code', 'user', $3, $3, 'active', true)`,
    [randomUUID(), ORPHAN_VERB, ORPHAN]
  );
}, 60_000);

const run = (
  verbId: string,
  automationRun: { sessionId: string; agentUserId: string | null } | null
) =>
  executeCapability({
    verbId,
    parameters: {},
    workspaceId: null,
    userId: PERSON,
    suppressProposal: true,
    automationRun,
  });

describe("an agent-authored automation's step finds the skill its agent made", () => {
  it("the person owns the skill, so the run finds it (the gate answers)", async () => {
    const out = await run(VERB, {
      sessionId: randomUUID(),
      agentUserId: AGENT,
    });
    expect(out).toMatchObject({ kind: "deny", reason: "reached the gate" });
  });

  it("the run's agent widens nothing: another user's skill stays out of reach", async () => {
    const out = await run(ORPHAN_VERB, {
      sessionId: randomUUID(),
      agentUserId: ORPHAN,
    });
    expect(out.kind).toBe("not_found");
  });
});
