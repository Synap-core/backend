/**
 * One agent, several computers: approving a connection never silently
 * switches another computer off.
 *
 * The 2026-10-12 incident: ONE `claude-code` identity shared by a laptop and a
 * devbox, keys with no instance id; approving ANY pending key revoked EVERY
 * other key of the identity — the laptop's working key died twice (once for
 * the devbox, once for a stale request from an earlier `synap init`).
 *
 * Driven on PGlite through the real `approvePendingAgentKey`, and through the
 * real pod-admin routes (`/setup/agent/pending/:keyId/details` and
 * `/approve`) with only the Kratos session mocked.
 *
 * Rows that rule out a wrong rule:
 *   (a) another computer's live key survives (rules out "revoke every sibling");
 *   (b) the same computer's live key IS replaced (rules out "revoke nothing");
 *   (c) an UNLABELLED live key survives unless chosen — and is revoked, with a
 *       reason naming who and what, when it is (rules out treating null as
 *       "same computer", the incident's exact shape);
 *   (d) a key of ANOTHER agent in `alsoDisconnect` refuses the whole approval
 *       (rules out "disconnect whatever id was posted");
 *   (e) the same computer's OLDER pending requests are expired on approval,
 *       and a stale one is never activated (rules out the stale-request
 *       approval that killed the laptop the second time); two UNLABELLED
 *       requests name no computer, so neither is judged stale.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID, createHash, randomBytes } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  sessionKratosId: "kratos-owner" as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: async () =>
    h.sessionKratosId ? { identity: { id: h.sessionKratosId } } : null,
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import {
  approvePendingAgentKey,
  REPLACED_FROM_THIS_COMPUTER,
  SUPERSEDED_REQUEST,
} from "./agent-connect.js";
import { isReplacementReason } from "./key-holder-state.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();

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

/** A real agent key row. Each test uses its own agent so rows never cross. */
async function mintKey(opts: {
  agent?: string;
  active: boolean;
  instanceId?: string | null;
  instanceLabel?: string | null;
  createdAt?: Date;
  lastUsedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  const secret = `synap_hub_live_${randomBytes(24).toString("hex")}`;
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name,
       key_prefix, key_hash, key_lookup_hash, scope, instance_id, instance_label,
       created_at, last_used_at)
     values ($1, $2, $3, $4, 'hub_inbound', 'Claude Code Hub Key', 'synap_hub_live_',
       $5, $6, '{}', $7, $8, $9, $10)`,
    [
      id,
      opts.agent ?? AGENT,
      OWNER,
      opts.active,
      `bcrypt-${id}`,
      createHash("sha256").update(secret).digest("hex"),
      opts.instanceId ?? null,
      opts.instanceLabel ?? null,
      opts.createdAt ?? new Date(),
      opts.lastUsedAt ?? null,
    ]
  );
  return id;
}

/** A fresh agent identity (person × agent type) for one test. */
async function newAgent(agentType = "claude-code"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, name, user_type, created_by_user_id, agent_type)
     values ($1, $2, 'Claude Code', 'agent', $3, $4)`,
    [id, `${id}@agents`, OWNER, agentType]
  );
  return id;
}

const row = async (id: string) =>
  (
    await q<{
      is_active: boolean;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `select is_active, revoked_at, revoked_reason from api_keys where id = $1`,
      [id]
    )
  ).rows[0]!;
const isLive = async (id: string) => {
  const r = await row(id);
  return r.is_active && r.revoked_at === null;
};

const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, name, user_type, kratos_identity_id)
     values ($1, 'owner@x', 'Antoine', 'human', 'kratos-owner')`,
    [OWNER]
  );
  for (const id of [AGENT, OTHER_AGENT])
    await q(
      `insert into users (id, email, name, user_type, created_by_user_id, agent_type)
       values ($1, $2, 'Claude Code', 'agent', $3, 'claude-code')`,
      [id, `${id}@agents`, OWNER]
    );
}, 120_000);

describe("approving one computer's connection", () => {
  it("(a) leaves ANOTHER computer's live key untouched", async () => {
    const agent = await newAgent();
    const laptop = await mintKey({
      agent,
      active: true,
      instanceId: "m-laptop",
      instanceLabel: "MacBook",
    });
    const devbox = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
      instanceLabel: "devbox",
    });
    expect(
      await approvePendingAgentKey({ keyId: devbox, approverId: OWNER })
    ).toBe("approved");
    expect(await isLive(laptop)).toBe(true);
    expect(await isLive(devbox)).toBe(true);
  });

  it("(b) REPLACES the same computer's live key, with a reason saying so", async () => {
    const agent = await newAgent();
    const old = await mintKey({
      agent,
      active: true,
      instanceId: "m-devbox",
      createdAt: ago(HOUR),
    });
    const fresh = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
    });
    expect(
      await approvePendingAgentKey({ keyId: fresh, approverId: OWNER })
    ).toBe("approved");
    const r = await row(old);
    expect(r.revoked_at).not.toBeNull();
    expect(r.revoked_reason).toBe(REPLACED_FROM_THIS_COMPUTER);
    // The holder's key-state still classifies it as a replacement.
    expect(isReplacementReason(r.revoked_reason)).toBe(true);
    expect(await isLive(fresh)).toBe(true);
  });

  it("(c) leaves an UNLABELLED live key alone — unless the approver chose it", async () => {
    // The incident's exact shape: an older-CLI key with no instance id.
    const agent = await newAgent();
    const unlabelled = await mintKey({
      agent,
      active: true,
      createdAt: ago(HOUR),
    });
    const first = await mintKey({ agent, active: false });
    expect(
      await approvePendingAgentKey({ keyId: first, approverId: OWNER })
    ).toBe("approved");
    expect(await isLive(unlabelled)).toBe(true);

    // Chosen explicitly: disconnected, and the reason names who and for what.
    const again = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
      instanceLabel: "devbox",
    });
    expect(
      await approvePendingAgentKey({
        keyId: again,
        approverId: OWNER,
        alsoDisconnect: [unlabelled],
      })
    ).toBe("approved");
    const r = await row(unlabelled);
    expect(r.revoked_at).not.toBeNull();
    // The reason is read back verbatim by anyone holding that key
    // (`/auth/key-state`): the role, never the approver's name or email.
    expect(r.revoked_reason).toBe(
      "Disconnected by the pod owner when approving Claude Code on devbox"
    );
    // A chosen disconnect is not a replacement — key-state must not say so.
    expect(isReplacementReason(r.revoked_reason)).toBe(false);
    // The other unlabelled key approved above was NOT chosen: still live.
    expect(await isLive(first)).toBe(true);
  });

  it("(d) a key of ANOTHER agent in alsoDisconnect refuses the whole approval", async () => {
    const agent = await newAgent();
    const foreign = await mintKey({
      agent: OTHER_AGENT,
      active: true,
      instanceId: "m-x",
    });
    const pending = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
    });
    await expect(
      approvePendingAgentKey({
        keyId: pending,
        approverId: OWNER,
        alsoDisconnect: [foreign],
      })
    ).rejects.toThrow(/only disconnect this agent's other connections/);
    // Nothing changed: the foreign key lives, the request still waits.
    expect(await isLive(foreign)).toBe(true);
    expect(await row(pending)).toMatchObject({
      is_active: false,
      revoked_at: null,
    });
    // An unknown id and the key itself are refused the same way.
    await expect(
      approvePendingAgentKey({
        keyId: pending,
        approverId: OWNER,
        alsoDisconnect: [randomUUID()],
      })
    ).rejects.toThrow(/only disconnect/);
    await expect(
      approvePendingAgentKey({
        keyId: pending,
        approverId: OWNER,
        alsoDisconnect: [pending],
      })
    ).rejects.toThrow(/only disconnect/);
  });

  it("(e) expires the same computer's OLDER pending requests — and never activates a stale one", async () => {
    const agent = await newAgent();
    const live = await mintKey({
      agent,
      active: true,
      instanceId: "m-laptop",
      createdAt: ago(3 * HOUR),
    });
    const stale1 = await mintKey({
      agent,
      active: false,
      instanceId: "m-laptop",
      createdAt: ago(2 * HOUR),
    });
    const stale2 = await mintKey({
      agent,
      active: false,
      instanceId: "m-laptop",
      createdAt: ago(HOUR),
    });
    const otherComputerPending = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
      createdAt: ago(2 * HOUR),
    });
    const newest = await mintKey({
      agent,
      active: false,
      instanceId: "m-laptop",
    });
    // Its open request card, so the expiry settles it too.
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, data, status, created_by)
       values ($1, 'agent', $2, 'connect', $3, 'pending', $4)`,
      [proposalId, agent, JSON.stringify({ keyId: stale1 }), OWNER]
    );

    // Approving a STALE request: refused as superseded, expired, never live —
    // and the computer's working key is untouched.
    expect(
      await approvePendingAgentKey({ keyId: stale2, approverId: OWNER })
    ).toBe("superseded");
    expect(await row(stale2)).toMatchObject({
      is_active: false,
      revoked_reason: SUPERSEDED_REQUEST,
    });
    expect(await isLive(live)).toBe(true);

    // Approving the newest: the older one is expired with its card.
    expect(
      await approvePendingAgentKey({ keyId: newest, approverId: OWNER })
    ).toBe("approved");
    expect((await row(stale1)).revoked_reason).toBe(SUPERSEDED_REQUEST);
    expect(
      (
        await q<{ status: string }>(
          `select status from proposals where id = $1`,
          [proposalId]
        )
      ).rows[0]!.status
    ).toBe("rejected");
    // Another computer's request is not this computer's stale one.
    expect(await row(otherComputerPending)).toMatchObject({
      is_active: false,
      revoked_at: null,
    });
    // This computer's old live key IS replaced by the approval.
    expect((await row(live)).revoked_reason).toBe(REPLACED_FROM_THIS_COMPUTER);
  });

  it("(e') two UNLABELLED requests name no computer: neither is judged stale", async () => {
    const agent = await newAgent();
    const older = await mintKey({ agent, active: false, createdAt: ago(HOUR) });
    const newer = await mintKey({ agent, active: false });
    expect(
      await approvePendingAgentKey({ keyId: older, approverId: OWNER })
    ).toBe("approved");
    expect(await row(newer)).toMatchObject({
      is_active: false,
      revoked_at: null,
    });
  });
});

describe("the pod-admin approval routes", () => {
  async function routes() {
    const { registerSetupRoutes } =
      await import("../routers/hub-protocol/rest/setup.js");
    const app = new OpenAPIHono();
    registerSetupRoutes(app as never);
    return app;
  }

  it("details: names this computer, lists the other live connections and which one approving replaces", async () => {
    const agent = await newAgent();
    const laptop = await mintKey({
      agent,
      active: true,
      instanceId: "m-laptop",
      instanceLabel: "MacBook",
      createdAt: ago(3 * HOUR),
      lastUsedAt: ago(60_000),
    });
    const devboxOld = await mintKey({
      agent,
      active: true,
      instanceId: "m-devbox",
      instanceLabel: "devbox",
      createdAt: ago(2 * HOUR),
    });
    const legacy = await mintKey({
      agent,
      active: true,
      createdAt: ago(4 * HOUR),
    });
    const stale = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
      createdAt: ago(HOUR),
    });
    const pending = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
      instanceLabel: "devbox",
    });
    const app = await routes();
    const res = await app.request(`/setup/agent/pending/${pending}/details`, {
      headers: { cookie: "ory_session=x" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.displayName).toBe("Claude Code on devbox");
    expect(body.instanceLabel).toBe("devbox");
    expect(body.supersededBy).toBeNull();
    const byId = new Map(
      (body.connections as Array<Record<string, any>>).map((c) => [c.keyId, c])
    );
    expect([...byId.keys()].sort()).toEqual([laptop, devboxOld, legacy].sort());
    expect(byId.get(laptop)).toMatchObject({
      displayName: "Claude Code on MacBook",
      sameComputer: false,
    });
    expect(byId.get(laptop)!.lastUsedAt).toEqual(expect.any(String));
    expect(byId.get(devboxOld)).toMatchObject({ sameComputer: true });
    expect(byId.get(legacy)).toMatchObject({
      instanceLabel: null,
      sameComputer: false,
      displayName: "Claude Code",
    });

    // The stale request knows it was superseded — the page does not offer it.
    const staleRes = await app.request(
      `/setup/agent/pending/${stale}/details`,
      { headers: { cookie: "ory_session=x" } }
    );
    expect(((await staleRes.json()) as any).supersededBy).toEqual({
      keyId: pending,
      createdAt: expect.any(String),
    });
  });

  it("approve: alsoDisconnect is honoured, a foreign id is a 400, a stale request a 409", async () => {
    const agent = await newAgent();
    const laptop = await mintKey({
      agent,
      active: true,
      instanceId: "m-laptop",
      createdAt: ago(2 * HOUR),
    });
    const legacy = await mintKey({
      agent,
      active: true,
      createdAt: ago(3 * HOUR),
    });
    const foreign = await mintKey({ agent: OTHER_AGENT, active: true });
    const stale = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
      createdAt: ago(HOUR),
    });
    const pending = await mintKey({
      agent,
      active: false,
      instanceId: "m-devbox",
    });
    const app = await routes();
    const post = (keyId: string, body?: unknown) =>
      app.request(`/setup/agent/pending/${keyId}/approve`, {
        method: "POST",
        headers: {
          cookie: "ory_session=x",
          "content-type": "application/json",
          // The pod-admin page (the CSRF floor refuses any other origin).
          origin: "http://localhost:4040",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    expect((await post(stale)).status).toBe(409);
    const bad = await post(pending, { alsoDisconnect: [foreign] });
    expect(bad.status).toBe(400);
    expect(await isLive(foreign)).toBe(true);
    expect((await row(pending)).is_active).toBe(false);

    const ok = await post(pending, { alsoDisconnect: [legacy] });
    expect(ok.status).toBe(200);
    expect(await isLive(pending)).toBe(true);
    expect(await isLive(legacy)).toBe(false);
    expect(await isLive(laptop)).toBe(true);
  });

  it("approve: an empty body (an older page) disconnects nothing else", async () => {
    const agent = await newAgent();
    const legacy = await mintKey({ agent, active: true, createdAt: ago(HOUR) });
    const pending = await mintKey({ agent, active: false });
    const app = await routes();
    const res = await app.request(`/setup/agent/pending/${pending}/approve`, {
      method: "POST",
      // The pod-admin page always sends JSON; an older one sends no body.
      headers: {
        cookie: "ory_session=x",
        "content-type": "application/json",
        origin: "http://localhost:4040",
      },
    });
    expect(res.status).toBe(200);
    expect(await isLive(legacy)).toBe(true);
    expect(await isLive(pending)).toBe(true);
  });
});
