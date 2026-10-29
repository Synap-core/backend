/**
 * D1 — `POST /setup/agent` takes the agent's computer from the CALLING key.
 *
 * 12b90604: the CLI calls `/setup/agent` with its computer's key, and the
 * door minted a computer-less agent: its grant was never clipped to the
 * computer's, revoking the computer left it working, and a second computer
 * reused the same principal.
 *
 * Driven on PGlite through the REAL route, the real device door (the
 * computer's key is collected, not hand-made) and the real revoke cascade.
 * Stubbed: audit, side effects, the governance verdict of the device
 * approval, and the `agent/connect` proposal filer.
 *
 * Pinned:
 *   - a computer's key → the agent's `host_user_id` is that computer;
 *     revoking the computer revokes the agent's key; a second computer gets
 *     a distinct agent;
 *   - Q-D1: an AI's own key cannot register another AI (403, nothing minted);
 *   - Q-D2: a computer-less agent is adopted onto its person's ONLY
 *     computer, once; with two computers a fresh agent is made instead;
 *   - `/users/me` names the key's holder and its computer.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../../../services/agent-connect.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fileAgentConnectProposal: async () => ({ proposalId: "prop-1" }),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import {
  collectDeviceToken,
  createDeviceRequest,
  decideDeviceRequest,
  getDeviceRequest,
  revokeMachine,
} from "../../../services/machine-connect.js";
import { provisionSurfaceAgentKey } from "../../../services/agent-identity-service.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerSetupRoutes } from "./setup.js";
import { registerUsersRoutes } from "./users.js";

const ONE = "human-one-computer";
const TWO = "human-two-computers";

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
        : c.hasDefault &&
            c.default !== undefined &&
            typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : c.default}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

/** A computer of `person`, through the real device door: its key + agents. */
async function connectComputer(
  person: string,
  hostname: string,
  agents: string[] = []
) {
  const res = await createDeviceRequest({
    clientName: "synap-cli",
    hostname,
    platform: "linux",
    agents,
    requesterIp: "203.0.113.7",
    userAgent: "synap-cli/1",
    podAdminOrigin: "https://admin.pod.test",
  });
  const view = await getDeviceRequest({
    userCode: res.user_code,
    personId: person,
  });
  await decideDeviceRequest({
    requestId: view.requestId,
    userCode: res.user_code,
    personId: person,
    decision: "approve",
    agents,
    computerName: hostname,
  });
  const got = await collectDeviceToken({ deviceCode: res.device_code });
  if (!got.ok) throw new Error(got.error);
  return got.body;
}

function app() {
  const a = new OpenAPIHono();
  a.use("*", hubAuthMiddleware as never);
  registerSetupRoutes(a as never);
  registerUsersRoutes(a as never);
  return a;
}

const setupAgent = (bearer: string, agentType: string) =>
  app().request("/setup/agent", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentType, instanceId: `inst-${agentType}` }),
  });

const userRow = async (id: string) =>
  (
    await q<{ id: string; host_user_id: string | null }>(
      `select id, host_user_id from users where id = $1`,
      [id]
    )
  )[0];

const liveKeysOf = (userId: string) =>
  q<{ id: string }>(
    `select id from api_keys where user_id = $1 and revoked_at is null`,
    [userId]
  );

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const id of [ONE, TWO])
    await q(
      `insert into users (id, email, user_type, email_verified, timezone, locale, is_personal_agent)
       values ($1, $1 || '@x', 'human', true, 'UTC', 'en', false)`,
      [id]
    );
}, 120_000);

describe("POST /setup/agent with a computer's key (D1)", () => {
  it("the agent runs on that computer; revoking the computer revokes it; another computer gets its own", async () => {
    const devbox = await connectComputer(TWO, "devbox");
    const res = await setupAgent(devbox.computer.apiKey, "codex");
    expect(res.status).toBe(200);
    const { agentUserId } = (await res.json()) as { agentUserId: string };
    expect((await userRow(agentUserId))!.host_user_id).toBe(devbox.computer.id);
    expect(await liveKeysOf(agentUserId)).toHaveLength(1);

    const laptop = await connectComputer(TWO, "laptop");
    const res2 = await setupAgent(laptop.computer.apiKey, "codex");
    expect(res2.status).toBe(200);
    const second = ((await res2.json()) as { agentUserId: string }).agentUserId;
    expect(second).not.toBe(agentUserId);
    expect((await userRow(second))!.host_user_id).toBe(laptop.computer.id);

    await revokeMachine({ machineUserId: devbox.computer.id, by: TWO });
    expect(await liveKeysOf(agentUserId)).toHaveLength(0);
    // The other computer's agent is untouched.
    expect(await liveKeysOf(second)).toHaveLength(1);
  });

  it("Q-D1: an AI's own key cannot connect another AI — 403, nothing minted", async () => {
    const box = await connectComputer(TWO, "ci-box", ["claude-code"]);
    const aiKey = box.agents[0]!.apiKey;
    const before = await q(`select id from users where agent_type = 'cursor'`);
    const res = await setupAgent(aiKey, "cursor");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "AGENT_KEY_CANNOT_REGISTER_AGENTS"
    );
    expect(await q(`select id from users where agent_type = 'cursor'`)).toEqual(
      before
    );
  });
});

describe("Q-D2: a computer-less agent is adopted once, when unambiguous", () => {
  it("one computer: the person's computer-less agent moves onto it, history kept", async () => {
    const old = await provisionSurfaceAgentKey({
      agentType: "raycast",
      createdByUserId: ONE,
      linkedUserId: ONE,
      hostUserId: null,
    });
    expect((await userRow(old.agentUserId))!.host_user_id).toBeNull();

    const only = await connectComputer(ONE, "only-box");
    const res = await setupAgent(only.computer.apiKey, "raycast");
    expect(res.status).toBe(200);
    const { agentUserId } = (await res.json()) as { agentUserId: string };
    expect(agentUserId).toBe(old.agentUserId);
    expect((await userRow(agentUserId))!.host_user_id).toBe(only.computer.id);
  });

  it("two computers: nothing is guessed — a fresh agent, the old one stays computer-less", async () => {
    // TWO already has several computers (the D1 tests above).
    expect(
      await q(
        `select id from users where agent_type = 'machine' and created_by_user_id = $1`,
        [TWO]
      )
    ).not.toHaveLength(1);
    const old = await provisionSurfaceAgentKey({
      agentType: "openwebui",
      createdByUserId: TWO,
      linkedUserId: TWO,
      hostUserId: null,
    });
    const box = await connectComputer(TWO, "another-box");
    const res = await setupAgent(box.computer.apiKey, "openwebui");
    expect(res.status).toBe(200);
    const { agentUserId } = (await res.json()) as { agentUserId: string };
    expect(agentUserId).not.toBe(old.agentUserId);
    expect((await userRow(agentUserId))!.host_user_id).toBe(box.computer.id);
    expect((await userRow(old.agentUserId))!.host_user_id).toBeNull();
  });
});

describe("GET /users/me names the key's holder (D1)", () => {
  it("a hosted agent reads its own id and its computer; a computer reads itself", async () => {
    const box = await connectComputer(ONE, "me-box", ["claude-code"]);
    const agent = box.agents[0]!;
    const me = await app().request("/users/me", {
      headers: { authorization: `Bearer ${agent.apiKey}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      id: string;
      principal: Record<string, unknown> | null;
    };
    // `id` stays the human the agent acts for; the holder rides apart.
    expect(body.id).toBe(ONE);
    expect(body.principal).toMatchObject({
      id: agent.agentUserId,
      kind: "agent",
      hostUserId: box.computer.id,
      hostName: "me-box",
    });

    const asComputer = await app().request("/users/me", {
      headers: { authorization: `Bearer ${box.computer.apiKey}` },
    });
    expect(
      ((await asComputer.json()) as { principal: unknown }).principal
    ).toMatchObject({
      id: box.computer.id,
      kind: "machine",
      hostUserId: box.computer.id,
    });
  });
});
