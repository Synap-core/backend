/**
 * An automation runs as its owner (the person); a skill its authoring agent
 * made for itself (`scope: "user"`, `skills.user_id` = the agent) must still
 * be found by its steps. `executeCapability` resolves the verb with the run's
 * agent (`automationRun.agentUserId`) as a second user-scope owner.
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
const VERB = "digest_my_inbox";

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([skills]));
  await h.client!.query(
    `insert into skills (id, name, kind, scope, user_id, status, approved)
     values ($1, $2, 'code', 'user', $3, 'active', true)`,
    [randomUUID(), VERB, AGENT]
  );
}, 60_000);

const run = (
  automationRun: { sessionId: string; agentUserId: string | null } | null
) =>
  executeCapability({
    verbId: VERB,
    parameters: {},
    workspaceId: null,
    userId: PERSON,
    suppressProposal: true,
    automationRun,
  });

describe("an agent-authored automation's step finds the agent's own skill", () => {
  it("with the run's agent, the skill is found (the gate answers)", async () => {
    const out = await run({ sessionId: randomUUID(), agentUserId: AGENT });
    expect(out).toMatchObject({ kind: "deny", reason: "reached the gate" });
  });

  it("CONTROL: a person's own automation does not see another user's skill", async () => {
    const out = await run({ sessionId: randomUUID(), agentUserId: null });
    expect(out.kind).toBe("not_found");
  });
});
