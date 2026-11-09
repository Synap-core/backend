/**
 * `services.register` — who may (re)register an intelligence service (W0).
 *
 * `intelligence_services` is POD-GLOBAL: its rows decide where the pod sends
 * chat turns (`webhookUrl`) and whose MCP tools it injects. The door had no
 * gate and no owner check, so ANY hub write key could re-point another
 * service's `webhookUrl` and force it `active`.
 *
 * Now: only a pod admin, or the IS's own `is_internal` key, may register; and
 * a row may be updated only by the identity that registered it through this
 * door (`metadata.registeredByUserId`), unless the caller is a pod admin.
 *
 * A pod admin's key adds an AI service whose origin then receives delegation
 * tokens: the sensitive act `intelligenceRegistry.register` (review of 6 Nov:
 * this Hub tRPC twin took no proof). It needs a proof bound to the call;
 * without one `enforce` (the default) refuses and `report` records. The IS's
 * own internal key is the provisioning path and asks nothing.
 *
 * Through the REAL procedure and the REAL proof-of-presence gate on PGlite
 * with every @synap/database table (a real P-256 device key signs).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import crypto, { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  // The gate's audit events, captured.
  class EventRepository {
    async append(e: { type: string; data: Record<string, unknown> }) {
      h.events.push({ type: e.type, data: e.data });
      return e;
    }
  }
  return { ...actual, db: h.db, getDb: async () => h.db, EventRepository };
});
vi.mock("@synap/auth", () => ({
  kratosAdmin: {
    getIdentity: async () => ({ data: { credentials: {} } }),
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { servicesRouter } from "./services.js";
import {
  presenceActionDigest,
  presenceActionSubject,
} from "@synap-core/types/presence";
import { issuePresenceChallenge } from "../../services/presence/proof.js";
import { invalidatePresenceMode } from "../../services/presence/mode.js";

const ADMIN = "admin-svc";
const ALICE = "alice-svc";
const IS_OPERATOR = "is-operator-svc";
const POD_ADMIN_WS = randomUUID();
/** The pod's IS row, written by /api/provision/register-intelligence. */
const PROVISIONED = "synap-is";
const GOOD_URL = "https://is.example.com/hook";
const EVIL_URL = "https://attacker.example.net/hook";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const keyCtx = (userId: string, keyType: string) =>
  ({
    db: h.db,
    authenticated: true,
    userId,
    apiKeyId: randomUUID(),
    keyType,
    scopes: ["hub-protocol.read", "hub-protocol.write"],
  }) as never;

const registration = (
  serviceId: string,
  webhookUrl = GOOD_URL,
  metadata?: Record<string, unknown>
) => ({
  serviceId,
  name: serviceId,
  webhookUrl,
  capabilities: ["chat"],
  ...(metadata ? { metadata } : {}),
});

const register = (
  userId: string,
  keyType: string,
  serviceId: string,
  webhookUrl = GOOD_URL,
  metadata?: Record<string, unknown>
) =>
  servicesRouter
    .createCaller(keyCtx(userId, keyType))
    .register(registration(serviceId, webhookUrl, metadata));

// ── The pod admin's device key (as Relay's Secure Enclave key signs) ─────────
const POD = "https://pod.example.test";
const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const DEVICE_KEY_ID = randomUUID();

/** A proof bound to exactly this registration, signed by the admin's device. */
async function proofFor(input: Record<string, unknown>, userId = ADMIN) {
  const path = "intelligenceRegistry.register";
  const c = await issuePresenceChallenge({
    userId,
    subject: presenceActionSubject(
      path,
      await presenceActionDigest(path, input)
    ),
  });
  return {
    kind: "device_key" as const,
    challengeId: c.challengeId,
    keyId: DEVICE_KEY_ID,
    signature: crypto
      .sign("sha256", Buffer.from(c.message, "utf8"), {
        key: device.privateKey,
        dsaEncoding: "der",
      })
      .toString("base64url"),
  };
}

/** A pod admin's registration WITH a proof bound to it. */
async function registerProved(
  userId: string,
  serviceId: string,
  webhookUrl = GOOD_URL,
  metadata?: Record<string, unknown>
) {
  const input = registration(serviceId, webhookUrl, metadata);
  return servicesRouter
    .createCaller(keyCtx(userId, "user_pat"))
    .register({ ...input, presence: await proofFor(input, userId) });
}

async function row(serviceId: string) {
  const { rows } = await q(
    `select webhook_url, status, metadata from intelligence_services where service_id = $1`,
    [serviceId]
  );
  return rows[0] as
    | {
        webhook_url: string;
        status: string;
        metadata: Record<string, unknown> | null;
      }
    | undefined;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const u of [ADMIN, ALICE, IS_OPERATOR])
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [u, `${u}@x`]
    );
  await q(
    `insert into workspaces (id, owner_id, name, system_slug) values ($1, $2, 'Pod admin', 'pod-admin')`,
    [POD_ADMIN_WS, ADMIN]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'admin')`,
    [POD_ADMIN_WS, ADMIN]
  );
  await q(
    `insert into intelligence_services (id, service_id, name, webhook_url, api_key, capabilities, status, enabled, metadata)
     values ('svc_prov', $1, 'Synap IS', $2, 'k', '["chat"]'::jsonb, 'active', true, '{}'::jsonb)`,
    [PROVISIONED, GOOD_URL]
  );
  await q(
    `insert into presence_device_keys (id, user_id, label, public_key) values ($1, $2, 'iPhone', $3)`,
    [
      DEVICE_KEY_ID,
      ADMIN,
      (
        device.publicKey.export({ format: "der", type: "spki" }) as Buffer
      ).toString("base64url"),
    ]
  );
});

beforeEach(async () => {
  process.env.PUBLIC_URL = POD;
  delete process.env.SYNAP_PRESENCE_PROOF;
  await h.client!.exec("delete from pod_settings");
  invalidatePresenceMode();
  h.events.length = 0;
});

describe("services.register — a plain key is refused", () => {
  it("a user_pat cannot re-point the pod's IS webhook", async () => {
    await expect(
      register(ALICE, "user_pat", PROVISIONED, EVIL_URL)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(PROVISIONED))?.webhook_url).toBe(GOOD_URL);
  });

  it("a user_pat cannot register a new service", async () => {
    await expect(
      register(ALICE, "user_pat", "alice-agent")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await row("alice-agent")).toBeUndefined();
  });

  it("an agent / service key is refused the same way", async () => {
    for (const keyType of ["hub_inbound", "service", "system"]) {
      await expect(
        register(ALICE, keyType, PROVISIONED, EVIL_URL)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await row(PROVISIONED))?.webhook_url).toBe(GOOD_URL);
  });
});

describe("services.register — is_internal and pod admin", () => {
  it("the is_internal key registers a new service, then re-registers its own row", async () => {
    await expect(
      register(IS_OPERATOR, "is_internal", "is-sidecar")
    ).resolves.toMatchObject({ status: "registered" });
    expect((await row("is-sidecar"))?.metadata).toMatchObject({
      registeredByUserId: IS_OPERATOR,
    });
    await expect(
      register(IS_OPERATOR, "is_internal", "is-sidecar", GOOD_URL + "/v2")
    ).resolves.toMatchObject({ status: "updated" });
    expect((await row("is-sidecar"))?.webhook_url).toBe(GOOD_URL + "/v2");
  });

  it("…but cannot update a row it did not register", async () => {
    await expect(
      register(IS_OPERATOR, "is_internal", PROVISIONED, EVIL_URL)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(PROVISIONED))?.webhook_url).toBe(GOOD_URL);
  });

  it("…and cannot take a row over by rewriting its provenance", async () => {
    await registerProved(ADMIN, "admin-svc-row");
    await expect(
      register(IS_OPERATOR, "is_internal", "admin-svc-row", EVIL_URL, {
        registeredByUserId: IS_OPERATOR,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nor can the owner hand its row to someone else through metadata.
    await register(IS_OPERATOR, "is_internal", "is-sidecar", GOOD_URL, {
      registeredByUserId: ALICE,
    });
    expect((await row("is-sidecar"))?.metadata).toMatchObject({
      registeredByUserId: IS_OPERATOR,
    });
  });

  it("a pod admin may update any row, including the provisioned one, with a proof", async () => {
    await expect(
      registerProved(ADMIN, PROVISIONED, GOOD_URL + "/admin")
    ).resolves.toMatchObject({ status: "updated" });
    expect((await row(PROVISIONED))?.webhook_url).toBe(GOOD_URL + "/admin");
    expect(h.events.map((e) => e.type)).toContain("presence.proved");
  });
});

describe("services.register — a pod admin's key needs the proof (review of 6 Nov)", () => {
  it("GUARDRAIL: with no proof, enforce (the default) refuses and writes nothing, naming pod admin", async () => {
    const err = await register(ADMIN, "user_pat", "no-proof-svc").catch(
      (e: Error & { cause?: { reasonCode?: string } }) => e
    );
    expect((err as { cause?: { reasonCode?: string } }).cause?.reasonCode).toBe(
      "PRESENCE_REQUIRED"
    );
    expect((err as Error).message).toMatch(/pod admin/);
    expect(await row("no-proof-svc")).toBeUndefined();
    // …nor can it re-point an existing row.
    await expect(
      register(ADMIN, "user_pat", PROVISIONED, EVIL_URL)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await row(PROVISIONED))?.webhook_url).not.toBe(EVIL_URL);
  });

  it("GUARDRAIL: a proof made for one registration is refused on another", async () => {
    const input = registration("bound-svc");
    const proof = await proofFor(input);
    await expect(
      servicesRouter
        .createCaller(keyCtx(ADMIN, "user_pat"))
        .register({ ...registration("bound-svc", EVIL_URL), presence: proof })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await row("bound-svc")).toBeUndefined();
  });

  it("report mode lets a pod admin's key through and records the missing proof", async () => {
    await q(
      `insert into pod_settings (id, settings) values (gen_random_uuid(), '{"presence":{"mode":"report"}}'::jsonb)`
    );
    invalidatePresenceMode();
    await expect(
      register(ADMIN, "user_pat", "report-svc")
    ).resolves.toMatchObject({ status: "registered" });
    expect(h.events).toEqual([
      expect.objectContaining({
        type: "presence.missing",
        data: expect.objectContaining({
          proposalType: "intelligenceRegistry.register",
          door: "hubProtocol.services.register",
        }),
      }),
    ]);
  });

  it("the IS's own internal key asks nothing (the provisioning path)", async () => {
    await expect(
      register(IS_OPERATOR, "is_internal", "is-no-proof")
    ).resolves.toMatchObject({ status: "registered" });
    expect(h.events).toEqual([]);
  });
});
