/**
 * AI DAILY PATHS — a fresh AI agent's key, minted the way `/setup/agent` mints
 * it (the agent row carries `aiDefaultCapabilities()`, the key gets its grant
 * from `attachAgentKeyGrant`, read back with `GrantRepository.resolveForKey`),
 * then driven on PGlite through the doors' own decision functions:
 *   - the governed write GATE in decision-only mode (`previewPermissionDecision`
 *     — the same `evaluatePermission` as `checkPermissionOrPropose`, every rung,
 *     no side effects), with each door's real `(subjectType, action)`;
 *   - the MCP read fence (`mcpToolAllowed`) and Hub REST fence;
 *   - the proposal decision doors' key half (`assertMayDecideProposal`,
 *     `assertAgentKeyMayReject`);
 *   - real routers for the doors that do not pass the gate (hub
 *     `channels.sendExternalMessage`, `agentUsers.disconnect`).
 *
 * Founder rule: the AI changes anything, never deletes, never approves,
 * nothing outward-facing or administrative.
 *
 * NOT COVERED (stated): a room post (`postChannelMessage`) is not a governed
 * write — no grant rung exists on it to refuse or allow; MCP tool → gate pair
 * binding is per door (cited beside each case), not re-derived here.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class EventRepository {
    async append(e: unknown) {
      return e;
    }
  }
  return { ...actual, db: h.db, getDb: async () => h.db, EventRepository };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  GrantRepository,
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import { aiDefaultCapabilities } from "@synap-core/types/grants";
import { attachAgentKeyGrant } from "./agent-identity-service.js";
import { previewPermissionDecision } from "../utils/permission-check.js";
import { mcpToolAllowed, restDoorAllowed } from "../access/grant-door-fence.js";
import { grantReadClause } from "../access/grant-read.js";
import {
  assertAgentKeyMayReject,
  assertMayDecideProposal,
} from "../routers/proposals/review-authority.js";
import { channelsRouter } from "../routers/hub-protocol/channels.js";
import { agentUsersRouter } from "../routers/agent-users.js";
import type { Context } from "../types/context.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

let grant: KeyGrant;

/** Run `fn` as the agent's key: its grant and its acting-agent scope. */
const asAgentKey = <T>(fn: () => Promise<T> | T) =>
  runWithGrant(grant, () => runWithActingAgent(AGENT, fn));

/** The gate's verdict for one door, as the agent's key. */
const gate = (
  subjectType: string,
  action: string,
  data: Record<string, unknown> = {}
) =>
  asAgentKey(() =>
    previewPermissionDecision({
      userId: OWNER,
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType,
      action,
      data,
    } as never)
  );

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'owner@x', 'human')`,
    [OWNER]
  );
  // `/setup/agent` creates a NEW AI with the "AI — read & propose" limits.
  for (const [id, email] of [
    [AGENT, "agent@x"],
    [OTHER_AGENT, "other-agent@x"],
  ])
    await q(
      `insert into users (id, email, user_type, created_by_user_id, agent_type, agent_metadata)
       values ($1, $2, 'agent', $3, 'claude-code', $4::jsonb)`,
      [
        id,
        email,
        OWNER,
        JSON.stringify({ capabilities: aiDefaultCapabilities() }),
      ]
    );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Builder', $2)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $2, $5, 'editor')`,
    [randomUUID(), WS, OWNER, randomUUID(), AGENT]
  );
  // A pod-wide kind the agent writes (entity.create needs a real profile).
  await q(
    `insert into profiles (id, slug, display_name, scope) values ($1, 'note', 'Note', 'system')`,
    [randomUUID()]
  );
  const keyId = randomUUID();
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope)
     values ($1, $2, $3, true, 'hub_inbound', 'Claude-code Hub Key', 'synap_', 'h', '{}')`,
    [keyId, AGENT, OWNER]
  );
  await attachAgentKeyGrant({
    apiKeyId: keyId,
    agentUserId: AGENT,
    onBehalfOf: OWNER,
    expiresAt: null,
    createdBy: OWNER,
  });
  grant = (await new GrantRepository(h.db as never).resolveForKey(keyId))!;
}, 120_000);

describe("the key minted for a new AI carries the preset (non-vacuity)", () => {
  it("is a scoped grant with the preset's verbs, not full access", () => {
    expect(grant.scopes).toHaveLength(1);
    const p = grant.scopes[0]!.permissions;
    expect(p).not.toContain("*");
    expect(p.some((x) => x.startsWith("entity") && x.endsWith(".create"))).toBe(
      true
    );
    expect(p).toContain("proposal.reject");
    expect(p).not.toContain("proposal.approve");
  });
});

describe("a new AI CAN do its daily work", () => {
  it("reads through the aggregate MCP doors: ask, orient, find", () => {
    for (const tool of ["synap_ask", "synap_orient", "synap_find"])
      expect(mcpToolAllowed(tool, true, grant), tool).toBe(true);
  });

  // Each pair is the door's own gate call:
  //   create entity     — hub entities.createEntity → entity/create
  //   start / update    — focus-sessions start/update → focus_session/*
  //   attach a facet    — synap_attach_facet → facet/attach
  //   a cell draft      — synap_create_cell → cell/define
  //   capture text      — capture.ts derived pair → entity/create, relation/create
  it.each([
    ["entity", "create", { profileSlug: "note" }],
    ["focus_session", "create", {}],
    ["focus_session", "update", {}],
    ["facet", "attach", {}],
    ["cell", "define", { name: "draft" }],
    ["relation", "create", {}],
  ] as const)(
    "%s.%s reaches review or runs — never refused",
    async (s, a, d) => {
      const v = await gate(s, a, { ...d });
      expect(v.decision, JSON.stringify(v)).not.toBe("deny");
    }
  );

  it("posts in its session room: a write tool, past the read fence (no grant rung on a room post)", () => {
    expect(mcpToolAllowed("synap_post_message", false, grant)).toBe(true);
  });

  it("rejects (withdraws) its OWN proposal", async () => {
    await asAgentKey(() => {
      assertMayDecideProposal("reject");
      assertAgentKeyMayReject({ agentUserId: AGENT }, "reject");
    });
  });
});

describe("a new AI CANNOT", () => {
  it.each([
    ["entity", "delete", { profileSlug: "note" }],
    ["automation", "activate", {}],
    ["automation", "execute", {}],
    ["automation", "delete", {}],
    ["apiKey", "create", {}],
    ["vault", "grant", {}],
  ] as const)("%s.%s — refused by its key", async (s, a, d) => {
    const v = await gate(s, a, { ...d });
    expect(v).toMatchObject({ decision: "deny" });
    expect((v as { reason: string }).reason).toMatch(/grant does not allow/);
  });

  it("approve a proposal (or revise anyone's)", async () => {
    expect(() => asAgentKey(() => assertMayDecideProposal("approve"))).toThrow(
      /may not approve/
    );
  });

  it("reject another agent's proposal", async () => {
    expect(() =>
      asAgentKey(() =>
        assertAgentKeyMayReject({ agentUserId: OTHER_AGENT }, "reject")
      )
    ).toThrow(/only reject its own/);
  });

  it("read the vault: the read hook narrows secrets to nothing, the door is fenced", () => {
    expect(grantReadClause(schema.secrets, grant.scopes[0]!)).toBeDefined();
    expect(restDoorAllowed("GET", "/vault/secrets", grant)).toBe(false);
  });

  it("send an external message (message.create) — nothing is relayed", async () => {
    const caller = channelsRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      agentUserId: AGENT,
      scopes: ["hub-protocol.write"],
      apiKeyId: "k",
    } as unknown as Context);
    await expect(
      asAgentKey(() =>
        caller.sendExternalMessage({
          workspaceId: WS,
          externalSource: "telegram",
          externalChannelId: "c1",
          senderName: "AI",
          content: "hello",
        } as never)
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("message.create"),
    });
  });

  it("call an outside service (capability.run)", async () => {
    const { grantWriteDenial } = await import("../utils/grant-write-check.js");
    expect(
      await asAgentKey(() =>
        grantWriteDenial({ subjectType: "capability", action: "run" })
      )
    ).toMatch(/capability\.run/);
  });

  it("mint or revoke a key (agent keys are refused at the agent doors)", async () => {
    const caller = agentUsersRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      agentUserId: AGENT,
    } as unknown as Context);
    await expect(
      asAgentKey(() => caller.disconnect({ agentUserId: OTHER_AGENT }))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
