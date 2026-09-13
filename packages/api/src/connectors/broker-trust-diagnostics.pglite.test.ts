/**
 * `readBrokerTrustDiagnostics` on a real Postgres (PGlite): the issuer lookup,
 * the owner identity-link predicate and the relay-credential row selection are
 * decided by SQL, not by a mock that ignores the where clause.
 *
 * Stubbed: `config.server.controlPlaneUrl`, the vault read (a ref → key map) and
 * the local Nango vault tier (absent). Tables are created from their drizzle
 * definitions (enums → text, constraints dropped).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    db: undefined as unknown,
    controlPlaneUrl: "https://cp.example.test" as string | undefined,
    vaultValues: {} as Record<string, string>,
  };
});

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  const server = new Proxy(actual.config.server, {
    get: (target, prop) =>
      prop === "controlPlaneUrl"
        ? h.controlPlaneUrl
        : (target as Record<string | symbol, unknown>)[prop],
  });
  return { ...actual, config: { ...actual.config, server } };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getServiceSecretResult: async () => ({
      ok: false,
      reason: "absent",
      error: "absent",
    }),
    resolveVaultReferences: async (cfg: Record<string, string>) => ({
      relayKey: h.vaultValues[cfg.relayKey!] ?? "",
    }),
  };
  Object.defineProperty(mocked, "db", { get: () => h.db, enumerable: true });
  Object.defineProperty(mocked, "getDb", {
    get: () => async () => h.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readBrokerTrustDiagnostics } from "./broker-trust-diagnostics.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const TABLES = [
  schema.trustedIssuers,
  schema.federatedIdentityLinks,
  schema.workspaces,
  schema.workspaceMembers,
  schema.sourceConfigs,
] as const;

const CP = "https://cp.example.test";
const OWNER = "owner-1";
const RELAY_KEY_REF = "vault://11111111-1111-1111-1111-111111111111/relayKey";

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  for (const table of TABLES) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  h.db = drizzle(client, { schema });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  for (const table of TABLES) {
    await client.exec(
      `delete from "${getTableConfig(table as unknown as PgTable).name}";`
    );
  }
  h.controlPlaneUrl = CP;
  h.vaultValues = {};
  delete process.env.CP_RELAY_KEY;
  delete process.env.SOURCE_RELAY_KEY;
  delete process.env.SYNAP_CONNECTOR_BROKER;
});

/** An unsigned JWT-shaped string whose `exp` is `days` from now. */
function jwtWithExp(days: number): { key: string; exp: Date } {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + days * 86_400;
  return {
    key: `${enc({ alg: "ES256" })}.${enc({ type: "pod_relay", podId: "pod-1", exp, marker: "SECRET-RELAY-MATERIAL" })}.sig`,
    exp: new Date(exp * 1000),
  };
}

async function seedIssuer(
  over: {
    url?: string;
    status?: string;
    scopes?: string[];
    builtIn?: boolean;
    displayName?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into trusted_issuers (id, issuer_url, display_name, allowed_scopes, status, is_built_in)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      over.url ?? CP,
      over.displayName ?? "Synap Control Plane",
      over.scopes ?? ["auth:exchange-user", "source-config:write"],
      over.status ?? "approved",
      over.builtIn ?? true,
    ]
  );
  return id;
}

async function seedPodAdmin(userId: string, role = "owner"): Promise<void> {
  const wsId = randomUUID();
  await client.query(
    `insert into workspaces (id, name, owner_id, system_slug) values ($1, 'Pod admin', $2, 'pod-admin')`,
    [wsId, userId]
  );
  await client.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
    [randomUUID(), wsId, userId, role]
  );
}

async function seedLink(issuerId: string, subject: string, userId: string) {
  await client.query(
    `insert into federated_identity_links (issuer_id, issuer_subject, user_id) values ($1, $2, $3)`,
    [issuerId, subject, userId]
  );
}

async function seedRelayRow(key: string): Promise<void> {
  h.vaultValues[RELAY_KEY_REF] = key;
  await client.query(
    `insert into source_configs (id, user_id, provider_type, name, config, enabled, created_at)
     values ($1, $2, 'cp-relay', 'Synap Relay (CP-managed)', $3::jsonb, true, now())`,
    [randomUUID(), OWNER, JSON.stringify({ relayKey: RELAY_KEY_REF })]
  );
}

describe("readBrokerTrustDiagnostics", () => {
  it("a fully trusted pod: approved issuer, owner linked, live credential, no broker fault", async () => {
    const issuerId = await seedIssuer();
    await seedPodAdmin(OWNER);
    await seedLink(issuerId, "cp-user-1", OWNER);
    const { key, exp } = jwtWithExp(10);
    await seedRelayRow(key);

    const d = await readBrokerTrustDiagnostics();

    expect(d).toEqual({
      cpIssuer: {
        present: true,
        status: "approved",
        hasSourceConfigWrite: true,
      },
      ownerIdentityLink: { present: true },
      relayCredential: { present: true, validUntil: exp.toISOString() },
      broker: { kind: "control-plane", reason: null },
    });
  });

  it("never carries key material or the vault ref (env or seeded row)", async () => {
    await seedIssuer();
    const { key } = jwtWithExp(10);
    await seedRelayRow(key);
    const fromRow = JSON.stringify(await readBrokerTrustDiagnostics());
    expect(fromRow).toContain('"present":true');
    expect(fromRow).not.toContain(key);
    expect(fromRow).not.toContain("SECRET-RELAY-MATERIAL");
    expect(fromRow).not.toContain(RELAY_KEY_REF);

    process.env.CP_RELAY_KEY = jwtWithExp(5).key;
    const fromEnv = JSON.stringify(await readBrokerTrustDiagnostics());
    expect(fromEnv).toContain('"present":true');
    expect(fromEnv).not.toContain(process.env.CP_RELAY_KEY);
    expect(fromEnv).not.toContain("SECRET-RELAY-MATERIAL");
  });

  it("no relay row: credential absent and the broker names broker-credential-missing", async () => {
    await seedIssuer();
    const d = await readBrokerTrustDiagnostics();
    expect(d.relayCredential).toEqual({ present: false, validUntil: null });
    expect(d.broker).toEqual({
      kind: "control-plane",
      reason: "broker-credential-missing",
    });
  });

  it("an expired credential is present with its past expiry, and still a broker fault", async () => {
    await seedIssuer();
    const { key, exp } = jwtWithExp(-1);
    await seedRelayRow(key);
    const d = await readBrokerTrustDiagnostics();
    expect(d.relayCredential).toEqual({
      present: true,
      validUntil: exp.toISOString(),
    });
    expect(d.broker.reason).toBe("broker-credential-missing");
  });

  it("a revoked issuer without source-config:write reports both facts", async () => {
    await seedIssuer({ status: "revoked", scopes: ["auth:exchange-user"] });
    const d = await readBrokerTrustDiagnostics();
    expect(d.cpIssuer).toEqual({
      present: true,
      status: "revoked",
      hasSourceConfigWrite: false,
    });
  });

  it("no issuer row: absent, and no identity link can exist for it", async () => {
    await seedPodAdmin(OWNER);
    const d = await readBrokerTrustDiagnostics();
    expect(d.cpIssuer).toEqual({
      present: false,
      status: null,
      hasSourceConfigWrite: false,
    });
    expect(d.ownerIdentityLink.present).toBe(false);
  });

  it("finds the built-in CP issuer seeded under a declared iss that differs from CONTROL_PLANE_URL", async () => {
    await seedIssuer({ url: "https://issuer.example.test" });
    const d = await readBrokerTrustDiagnostics();
    expect(d.cpIssuer.present).toBe(true);
  });

  it("a link bound to a user who is not a pod owner/admin is not the owner's link", async () => {
    const issuerId = await seedIssuer();
    await seedPodAdmin(OWNER);
    await seedLink(issuerId, "cp-user-9", "someone-else");
    const d = await readBrokerTrustDiagnostics();
    expect(d.ownerIdentityLink.present).toBe(false);
  });

  it("with a verified CP subject the link check is exact", async () => {
    const issuerId = await seedIssuer();
    await seedPodAdmin(OWNER);
    await seedLink(issuerId, "cp-user-1", OWNER);

    const linked = await readBrokerTrustDiagnostics({
      issuerUrl: CP,
      issuerSubject: "cp-user-1",
    });
    expect(linked.ownerIdentityLink.present).toBe(true);

    // The owner IS linked, but not under this subject — a delivery carrying it
    // would be refused, so the answer is false.
    const other = await readBrokerTrustDiagnostics({
      issuerUrl: CP,
      issuerSubject: "cp-user-2",
    });
    expect(other.ownerIdentityLink.present).toBe(false);
  });

  it("a pod with no CONTROL_PLANE_URL is locally brokered and has no CP issuer", async () => {
    h.controlPlaneUrl = undefined;
    await seedIssuer();
    const d = await readBrokerTrustDiagnostics();
    expect(d.broker.kind).toBe("local");
    expect(d.cpIssuer.present).toBe(false);
  });

  it("a failed read throws — it is never reported as absent rows", async () => {
    await client.exec(
      `alter table source_configs rename to source_configs_gone;`
    );
    try {
      await seedIssuer();
      await expect(readBrokerTrustDiagnostics()).rejects.toThrow();
    } finally {
      await client.exec(
        `alter table source_configs_gone rename to source_configs;`
      );
    }
  });
});
