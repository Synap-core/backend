/**
 * The holder of a key that does not work learns WHY — and one computer's
 * approval never switches another computer's key off.
 *
 * Driven on PGlite through the real pieces: the hub auth middleware (so the
 * route is proven reachable for a key that FAILS auth), `GET /auth/key-state`,
 * `describeKeyForHolder` over the real `getApiKeyStatus`, and the real
 * `approvePendingAgentKey`.
 *
 * Rows that rule out a wrong rule:
 *   - a pending key reads `awaiting_approval`, NOT revoked (the 2026-10-12
 *     incident: `whoami` called a pending key "revoked or expired");
 *   - a replaced key names WHEN and WHERE its replacer was created, and the
 *     answer carries no secret, hash or id of that replacer;
 *   - an unknown secret gets the bare `{ state: "unknown" }` — the same shape
 *     as a malformed one, so nothing about other keys is enumerable;
 *   - approving machine B's pending key leaves machine A's live key active
 *     when both carry their own `instanceId`, and (legacy, the incident)
 *     revokes it when neither does.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID, createHash, randomBytes } from "node:crypto";

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
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { isReplacementReason } from "./key-holder-state.js";
import { approvePendingAgentKey } from "./agent-connect.js";
import { apiKeyService } from "./api-keys.js";
import { hubAuthMiddleware } from "../routers/hub-protocol/_middleware/auth.js";
import { registerAuthRoutes } from "../routers/hub-protocol/rest/auth.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const POD = "https://pod.example.test";

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

interface Key {
  id: string;
  secret: string;
}

/** A real agent key row: sha256 lookup hash of a real `synap_hub_live_` secret. */
async function mintKey(opts: {
  active: boolean;
  instanceId?: string | null;
  createdAt?: Date;
  expiresAt?: Date | null;
}): Promise<Key> {
  const id = randomUUID();
  const secret = `synap_hub_live_${randomBytes(24).toString("hex")}`;
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name,
       key_prefix, key_hash, key_lookup_hash, scope, instance_id, created_at, expires_at)
     values ($1, $2, $3, $4, 'hub_inbound', 'Claude-code Hub Key', 'synap_hub_live_',
       $5, $6, '{}', $7, $8, $9)`,
    [
      id,
      AGENT,
      OWNER,
      opts.active,
      `bcrypt-${id}`,
      createHash("sha256").update(secret).digest("hex"),
      opts.instanceId ?? null,
      opts.createdAt ?? new Date(),
      opts.expiresAt ?? null,
    ]
  );
  return { id, secret };
}

const row = async (id: string) =>
  (
    await q<{ is_active: boolean; revoked_at: Date | null }>(
      `select is_active, revoked_at from api_keys where id = $1`,
      [id]
    )
  ).rows[0]!;

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", hubAuthMiddleware);
  registerAuthRoutes(a);
  const outer = new OpenAPIHono();
  outer.route("/api/hub", a as never);
  return outer as unknown as HubHono;
}

async function keyState(secret: string | null) {
  const res = await app().request(`${POD}/api/hub/auth/key-state`, {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'owner@x', 'human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type)
     values ($1, 'agent@x', 'agent', $2, 'claude-code')`,
    [AGENT, OWNER]
  );
  // Every approval below is the OWNER's; the admin fallback is never reached.
}, 120_000);

describe("the holder learns why its key does not work", () => {
  it("a pending key is awaiting approval — with its approval page — not revoked", async () => {
    const pending = await mintKey({ active: false, instanceId: "m-devbox" });
    const { status, body } = await keyState(pending.secret);
    // The route is reached although the key FAILS auth (skip-listed).
    expect(status).toBe(200);
    expect(body.state).toBe("awaiting_approval");
    expect(body.keyId).toBe(pending.id);
    expect(body.instanceId).toBe("m-devbox");
    expect(body.agentType).toBe("claude-code");
    expect(body.approvalUrl).toBe(
      `https://pod-admin.example.test/approve-agent/${pending.id}?agentType=claude-code`
    );
    // The same key, presented to an ordinary hub route, is still refused.
    const refused = await app().request(`${POD}/api/hub/auth/status`, {
      headers: { Authorization: `Bearer ${pending.secret}` },
    });
    expect(refused.status).toBe(401);
  });

  it("an active key is active", async () => {
    const live = await mintKey({ active: true, instanceId: "m-live" });
    const { body } = await keyState(live.secret);
    expect(body.state).toBe("active");
    expect(body.approvalUrl).toBeUndefined();
  });

  it("an expired key is expired", async () => {
    const old = await mintKey({
      active: true,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await keyState(old.secret)).body.state).toBe("expired");
  });

  it("a key replaced by an approved connection names when and where its replacer was made — and nothing secret", async () => {
    // The incident, legacy shape: two computers, no instance labels.
    const laptop = await mintKey({
      active: true,
      createdAt: new Date(Date.now() - 86_400_000),
    });
    const devbox = await mintKey({ active: false });
    expect(
      await approvePendingAgentKey({ keyId: devbox.id, approverId: OWNER })
    ).toBe("approved");
    const { body } = await keyState(laptop.secret);
    expect(body.state).toBe("revoked");
    expect(body.revokedReason).toMatch(/replaced/i);
    expect(typeof body.revokedAt).toBe("string");
    const devboxCreated = (
      await q<{ created_at: Date }>(
        `select created_at from api_keys where id = $1`,
        [devbox.id]
      )
    ).rows[0]!.created_at;
    expect(body.replacedBy).toEqual({
      createdAt: new Date(devboxCreated).toISOString(),
      instanceId: null,
    });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(devbox.secret);
    expect(wire).not.toContain(devbox.id);
    expect(wire).not.toContain(`bcrypt-${devbox.id}`);
    expect(wire).not.toContain(
      createHash("sha256").update(devbox.secret).digest("hex")
    );
  });

  it("a key revoked for another reason carries the reason, not a replacer", async () => {
    const k = await mintKey({ active: true });
    await q(
      `update api_keys set is_active = false, revoked_at = now(), revoked_reason = 'Disconnected by owner' where id = $1`,
      [k.id]
    );
    apiKeyService.invalidateVerificationCache();
    const { body } = await keyState(k.secret);
    expect(body.state).toBe("revoked");
    expect(body.revokedReason).toBe("Disconnected by owner");
    expect(body).not.toHaveProperty("replacedBy");
  });

  it("an unknown secret and a malformed one get the same bare answer", async () => {
    const unknown = await keyState(
      `synap_hub_live_${randomBytes(24).toString("hex")}`
    );
    const malformed = await keyState("not-a-key");
    expect(unknown).toEqual({ status: 200, body: { state: "unknown" } });
    expect(malformed).toEqual({ status: 200, body: { state: "unknown" } });
  });

  it("no bearer at all is the standard 401 envelope", async () => {
    const { status, body } = await keyState(null);
    expect(status).toBe(401);
    expect(body.reason).toBe("no_auth");
  });
});

describe("one key per computer: approval replaces only this computer's key", () => {
  it("approving computer B's connection leaves computer A's live key working", async () => {
    const laptop = await mintKey({ active: true, instanceId: "m-laptop" });
    const devboxOld = await mintKey({ active: true, instanceId: "m-devbox" });
    const devboxNew = await mintKey({ active: false, instanceId: "m-devbox" });
    expect(
      await approvePendingAgentKey({ keyId: devboxNew.id, approverId: OWNER })
    ).toBe("approved");
    expect((await row(laptop.id)).is_active).toBe(true);
    expect((await row(laptop.id)).revoked_at).toBeNull();
    // Its own predecessor on the same computer IS replaced.
    expect((await row(devboxOld.id)).revoked_at).not.toBeNull();
    apiKeyService.invalidateVerificationCache();
    expect((await keyState(laptop.secret)).body.state).toBe("active");
    const replaced = (await keyState(devboxOld.secret)).body;
    expect(replaced.state).toBe("revoked");
    expect(replaced.replacedBy?.instanceId).toBe("m-devbox");
  });
});

describe("tripwire: the replacement reasons the classifier reads", () => {
  it("both revoke reasons that mean 'replaced' classify as replacement", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const here = path.dirname(new URL(import.meta.url).pathname);
    const sources = {
      approval: fs.readFileSync(path.join(here, "agent-connect.ts"), "utf8"),
      reprovision: fs.readFileSync(
        path.join(here, "agent-identity-service.ts"),
        "utf8"
      ),
    };
    const reasons = Object.values(sources).flatMap((src) =>
      [...src.matchAll(/[rR]eason:\s*"([^"]*[Rr]eplaced[^"]*)"/g)].map(
        (m) => m[1]!
      )
    );
    // Non-vacuity: both literals are still where they were.
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Replaced by a newly approved connection",
        "Re-provisioning — replaced by new key via setup/agent",
      ])
    );
    for (const r of reasons) expect(isReplacementReason(r)).toBe(true);
    expect(isReplacementReason("Rejected at approval")).toBe(false);
    expect(isReplacementReason(null)).toBe(false);
  });
});
