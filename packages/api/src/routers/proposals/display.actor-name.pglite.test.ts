/**
 * WHO IS ASKING — an agent that runs on a computer reaches every review surface
 * as "Claude Code on devbox" (`agentDisplayName`, the ONE phrasing the rosters
 * and governance rows already use), never as the bare agent-user name its twin
 * on another computer also carries. Driven through the REAL
 * `enrichProposalsForDisplay` on PGlite: the users rows (`host_user_id`, the
 * computer's own row) are the only input; nothing between them and the
 * enriched fields is hand-built.
 *
 * Discriminating fixtures: two agents with the SAME `users.name`, one on a
 * computer and one on none — the exact input on which "read `users.name`" and
 * the host-aware rule disagree — and an agent with no name (the pod's system
 * orchestrator), which `displayNameForUser` alone names "orchestrator".
 *
 * What this cannot see: the surfaces that render the name (pod-admin Review,
 * browser, relay) — they read `agentActorName` / `authorName` as served.
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const WS = randomUUID();
const COMPUTER = "computer-user";
const ON_COMPUTER = "agent-on-computer";
const NO_COMPUTER = "agent-on-no-computer";
const UNNAMED = "agent-with-no-name";
// B7: one agent user, three keys — two computers that named themselves and a
// key minted before the CLI sent a name.
const KEY_MAC = randomUUID();
const KEY_DEVBOX = randomUUID();
const KEY_UNNAMED = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function enrichAs(agentUserId: string | null, apiKeyId?: string) {
  const now = new Date();
  const [row] = await enrichProposalsForDisplay(
    [
      {
        id: randomUUID(),
        status: "pending",
        proposalType: "create",
        targetType: "entity",
        targetId: randomUUID(),
        data: {},
        workspaceId: WS,
        projectId: null,
        threadId: null,
        sessionId: null,
        correlationId: null,
        agentUserId,
        apiKeyId: apiKeyId ?? null,
        subjectUserId: VIEWER,
        createdBy: agentUserId ?? VIEWER,
        reviewedBy: null,
        createdAt: now,
        updatedAt: now,
      } as never,
    ],
    VIEWER
  );
  return row as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into workspaces (id, name, owner_id) values ($1,'W',$2)`, [
    WS,
    VIEWER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, VIEWER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id, host_user_id) values
      ($1,'devbox','m@x','agent','machine','{"agentType":"machine"}'::jsonb,$4,null),
      ($2,'Claude Code','a@x','agent','claude-code','{"agentType":"claude-code"}'::jsonb,$4,$1),
      ($3,'Claude Code','b@x','agent','claude-code','{"agentType":"claude-code"}'::jsonb,$4,null),
      ($4,'Owner','o@x','human',null,null,null,null),
      ($5,null,'u@x','agent','orchestrator','{"agentType":"orchestrator"}'::jsonb,$4,null)`,
    [COMPUTER, ON_COMPUTER, NO_COMPUTER, VIEWER, UNNAMED]
  );
  await q(
    `insert into api_keys (id, user_id, instance_label) values
      ($1,$4,'MacBook'), ($2,$4,'devbox'), ($3,$4,null)`,
    [KEY_MAC, KEY_DEVBOX, KEY_UNNAMED, NO_COMPUTER]
  );
});

describe("enrichProposalsForDisplay — the asking agent's name", () => {
  it("an agent on a computer is named with it, as actor and as author", async () => {
    const row = await enrichAs(ON_COMPUTER);
    expect(row.agentActorName).toBe("Claude Code on devbox");
    expect(row.authorName).toBe("Claude Code on devbox");
  });

  it("its twin on no computer keeps its own name", async () => {
    const row = await enrichAs(NO_COMPUTER);
    expect(row.agentActorName).toBe("Claude Code");
    expect(row.authorName).toBe("Claude Code");
  });

  it("an agent with no name is named from its type, never the raw token", async () => {
    const row = await enrichAs(UNNAMED);
    expect(row.agentActorName).toBe("Orchestrator");
    expect(row.authorName).toBe("Orchestrator");
  });

  it("B7: the filing KEY names the computer — one agent, two computers, two names", async () => {
    const mac = await enrichAs(NO_COMPUTER, KEY_MAC);
    const devbox = await enrichAs(NO_COMPUTER, KEY_DEVBOX);
    expect(mac.agentActorName).toBe("Claude Code on MacBook");
    expect(mac.authorName).toBe("Claude Code on MacBook");
    expect(devbox.agentActorName).toBe("Claude Code on devbox");
  });

  it("B7: an unnamed key falls back to the agent's own computer, then its name", async () => {
    expect((await enrichAs(NO_COMPUTER, KEY_UNNAMED)).agentActorName).toBe(
      "Claude Code"
    );
    expect((await enrichAs(ON_COMPUTER, KEY_UNNAMED)).agentActorName).toBe(
      "Claude Code on devbox"
    );
  });

  it("a person's proposal names the person and has no agent actor", async () => {
    const row = await enrichAs(null);
    expect(row.authorName).toBe("Owner");
    expect(row).not.toHaveProperty("agentActorName");
  });
});
