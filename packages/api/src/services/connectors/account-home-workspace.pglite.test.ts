/**
 * A messaging account with no pin is homed in its user's first space. A
 * person owns their agent's space (0445, provision-agent), so an agent's
 * account finds that space through `settings.linkedAgentId`; a person's
 * account never lands in an agent's space they own.
 *
 * Real: the home query on PGlite (workspaces from the drizzle schema).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
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

import { workspaces } from "@synap/database/schema";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";

const { accountHomeWorkspace } = await import("./account-home-workspace.js");

const PERSON = "person-1";
const AGENT = "agent-1";
const LONER = "agent-without-space";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const AGENT_SPACE = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([workspaces]));
  // The agent's space is the OLDER one: a person's account must still skip it.
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, created_at)
     values ($1, 'Agent KB', $2, 'agent', $3::jsonb, '2026-01-01'),
            ($4, 'Home', $2, 'personal', '{}'::jsonb, '2026-02-01')`,
    [AGENT_SPACE, PERSON, JSON.stringify({ linkedAgentId: AGENT }), PERSONAL]
  );
}, 60_000);

describe("accountHomeWorkspace", () => {
  it("an agent's unpinned account is homed in its own space, which its person owns", async () => {
    expect(
      await accountHomeWorkspace({ workspaceId: null, userId: AGENT })
    ).toBe(AGENT_SPACE);
  });

  it("a person's unpinned account is homed in their first space that is not an agent's", async () => {
    expect(
      await accountHomeWorkspace({ workspaceId: null, userId: PERSON })
    ).toBe(PERSONAL);
  });

  it("an agent with no space gets none (the pin wins when set)", async () => {
    expect(
      await accountHomeWorkspace({ workspaceId: null, userId: LONER })
    ).toBeNull();
    expect(
      await accountHomeWorkspace({ workspaceId: "pinned", userId: LONER })
    ).toBe("pinned");
  });
});
