/**
 * Synap's catalog signature check on a REAL engine (PGlite): the chain root
 * key → keys statement → index, fetched through an injected fetch, and what
 * it leaves in `official_catalog_digests` and `pod_settings`:
 *   - no trust anchor (the ceremony has not happened): nothing is fetched,
 *     nothing recorded;
 *   - a verified index replaces the digests and records `ok`;
 *   - a refused index (rogue key) or a replayed statement keeps the last
 *     verified digests — never wiped — and records why;
 *   - operator keys sign the index directly, with no keys statement;
 *   - the report-only pass counts the cached rows the index does not vouch for.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

import { readMarketplaceSources } from "@synap/database";
import {
  checkOfficialCatalogSignature,
  officialCatalogTrust,
  reportUnverifiedOfficialRows,
  type OfficialCatalogTrust,
} from "../official-catalog-signature.js";
import { officialContentHash } from "../marketplace-source-verify.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64"),
    privateKey,
  };
}
type Key = ReturnType<typeof keypair>;

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const BASE = "https://cp.example.test";
const ROOT = keypair();
const CATALOG = keypair();

const CAP = { key: "gmail", name: "Gmail", tools: [] };
const CAP_HASH = officialContentHash("capability", CAP);

function signed(value: unknown, key: Key) {
  const body = Buffer.from(JSON.stringify(value));
  return { body, sig: sign(null, body, key.privateKey).toString("base64") };
}

function keysFile(version: number, signer: Key = ROOT) {
  return signed(
    {
      schemaVersion: 1,
      version,
      expires: at(200),
      keys: [{ publicKey: CATALOG.publicKey, notAfter: at(60) }],
    },
    signer
  );
}

function indexFile(signer: Key = CATALOG, contentHash = CAP_HASH) {
  return signed(
    {
      schemaVersion: 1,
      source: { id: "synap", name: "Synap", publicKey: signer.publicKey },
      expires: at(14),
      packages: [
        {
          slug: "gmail",
          kind: "capability",
          version: `h-${contentHash.slice(0, 12)}`,
          displayName: "Gmail",
          definitionUrl: "/api/packages/gmail/definition.json",
          sha256: contentHash,
          contentHash,
          requiredTier: "pro",
        },
      ],
    },
    signer
  );
}

/** A fetch serving the signed files by path; anything else is a 404. */
function served(files: Record<string, { body: Buffer; sig: string }>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    for (const [path, file] of Object.entries(files)) {
      if (url === `${BASE}${path}`) return new Response(file.body);
      if (url === `${BASE}${path}.sig`) return new Response(file.sig);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

const ROOTS: OfficialCatalogTrust = {
  anchors: "roots",
  keys: [ROOT.publicKey],
  enforce: false,
  allowExpired: false,
  rejectedKeys: [],
};

beforeAll(async () => {
  await h.client!.exec(`
    create table pod_settings (
      id uuid primary key default gen_random_uuid(),
      settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table cp_catalog_cache (
      id uuid primary key default gen_random_uuid(),
      source text not null, kind text not null, slug text not null,
      name text not null, description text, version text, tier text,
      vendor text, tags text[], content_hash text, definition jsonb,
      listing jsonb, retired_at timestamptz, replaced_by_slug text,
      retired_reason text, synced_at timestamptz not null default now()
    );
    create table official_catalog_digests (
      kind text not null, slug text not null, version text not null,
      content_hash text not null, required_tier text,
      synced_at timestamptz not null default now(),
      primary key (kind, slug)
    );
  `);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from pod_settings; delete from cp_catalog_cache; delete from official_catalog_digests;`
  );
  await q(`insert into pod_settings (settings) values ('{}'::jsonb)`);
});

const digests = () =>
  q<{
    kind: string;
    slug: string;
    content_hash: string;
    required_tier: string;
  }>(
    `select kind, slug, content_hash, required_tier from official_catalog_digests order by slug`
  ).then((r) => r.rows);

describe("officialCatalogTrust", () => {
  it("has no anchor until the release carries root keys or the operator sets keys", () => {
    expect(officialCatalogTrust({}, []).anchors).toBe("none");
    expect(officialCatalogTrust({}, [ROOT.publicKey]).anchors).toBe("roots");
    const op = officialCatalogTrust(
      {
        SYNAP_CATALOG_PUBLIC_KEYS: `${CATALOG.publicKey}, not-a-key`,
        SYNAP_CATALOG_ENFORCE_SIGNATURE: "1",
        SYNAP_CATALOG_ALLOW_EXPIRED: "true",
      },
      [ROOT.publicKey]
    );
    expect(op).toMatchObject({
      anchors: "operator",
      keys: [CATALOG.publicKey],
      enforce: true,
      allowExpired: true,
      rejectedKeys: ["not-a-key"],
    });
  });
});

describe("checkOfficialCatalogSignature on PGlite", () => {
  it("fetches and records nothing while no trust anchor is configured", async () => {
    const { fetchImpl, calls } = served({});
    const status = await checkOfficialCatalogSignature(BASE, null, {
      fetchImpl,
      now: NOW,
      trust: { ...ROOTS, anchors: "none", keys: [] },
    });
    expect(status).toBeNull();
    expect(calls).toEqual([]);
    expect((await readMarketplaceSources()).officialSignature).toBeNull();
  });

  it("verifies root → keys statement → index and stores the listed digests", async () => {
    const { fetchImpl } = served({
      "/api/marketplace/synap-catalog-keys.json": keysFile(3),
      "/api/marketplace/synap-index.json": indexFile(),
    });
    const status = await checkOfficialCatalogSignature(BASE, null, {
      fetchImpl,
      now: NOW,
      trust: ROOTS,
    });
    expect(status).toMatchObject({
      state: "ok",
      keysVersion: 3,
      packageCount: 1,
      validUntil: at(14),
    });
    expect(await digests()).toEqual([
      {
        kind: "capability",
        slug: "gmail",
        content_hash: CAP_HASH,
        required_tier: "pro",
      },
    ]);
    expect((await readMarketplaceSources()).officialSignature?.state).toBe(
      "ok"
    );
  });

  it("keeps the last verified digests when an index is signed by a key the statement does not name", async () => {
    const good = served({
      "/api/marketplace/synap-catalog-keys.json": keysFile(3),
      "/api/marketplace/synap-index.json": indexFile(),
    });
    const first = await checkOfficialCatalogSignature(BASE, null, {
      fetchImpl: good.fetchImpl,
      now: NOW,
      trust: ROOTS,
    });
    const rogue = keypair();
    const bad = served({
      "/api/marketplace/synap-catalog-keys.json": keysFile(3),
      "/api/marketplace/synap-index.json": indexFile(rogue, "f".repeat(64)),
    });
    const second = await checkOfficialCatalogSignature(BASE, first, {
      fetchImpl: bad.fetchImpl,
      now: NOW,
      trust: ROOTS,
    });
    expect(second).toMatchObject({
      state: "bad_signature",
      lastOkAt: first!.lastOkAt,
      validUntil: first!.validUntil,
    });
    expect((await digests())[0]?.content_hash).toBe(CAP_HASH);
  });

  it("refuses an older keys statement than the one already accepted", async () => {
    const { fetchImpl } = served({
      "/api/marketplace/synap-catalog-keys.json": keysFile(2),
      "/api/marketplace/synap-index.json": indexFile(),
    });
    const status = await checkOfficialCatalogSignature(
      BASE,
      {
        state: "ok",
        lastCheckAt: NOW.toISOString(),
        lastOkAt: NOW.toISOString(),
        validUntil: at(10),
        keysVersion: 3,
        keyFingerprint: null,
        packageCount: 0,
        unverifiedRows: null,
        message: null,
      },
      { fetchImpl, now: NOW, trust: ROOTS }
    );
    expect(status?.state).toBe("replayed");
    expect(await digests()).toEqual([]);
  });

  it("reports a Control Plane that serves no signed index yet as unreachable", async () => {
    const { fetchImpl } = served({
      "/api/marketplace/synap-catalog-keys.json": keysFile(1),
    });
    const status = await checkOfficialCatalogSignature(BASE, null, {
      fetchImpl,
      now: NOW,
      trust: ROOTS,
    });
    expect(status).toMatchObject({ state: "unreachable" });
    expect(status?.message).toMatch(/doesn't serve/);
  });

  it("checks the index directly against operator keys, with no keys statement", async () => {
    const { fetchImpl, calls } = served({
      "/api/marketplace/synap-index.json": indexFile(),
    });
    const status = await checkOfficialCatalogSignature(BASE, null, {
      fetchImpl,
      now: NOW,
      trust: { ...ROOTS, anchors: "operator", keys: [CATALOG.publicKey] },
    });
    expect(status).toMatchObject({ state: "ok", keysVersion: null });
    expect(calls.some((u) => u.includes("synap-catalog-keys"))).toBe(false);
  });

  it("counts the cached rows the verified index does not vouch for", async () => {
    const { fetchImpl } = served({
      "/api/marketplace/synap-catalog-keys.json": keysFile(1),
      "/api/marketplace/synap-index.json": indexFile(),
    });
    const status = await checkOfficialCatalogSignature(BASE, null, {
      fetchImpl,
      now: NOW,
      trust: ROOTS,
    });
    await q(
      `insert into cp_catalog_cache (source, kind, slug, name, version, definition) values
        ($1, 'capability', 'gmail', 'Gmail', $2, $3::jsonb),
        ($1, 'capability', 'slack', 'Slack', 'h-1', '{"key":"slack"}'::jsonb),
        ($1, 'template', 'crm', 'CRM', 'h-2', null),
        ('acme', 'template', 'crm', 'Acme CRM', 'v1', null)`,
      [BASE, `h-${CAP_HASH.slice(0, 12)}`, JSON.stringify(CAP)]
    );
    const next = await reportUnverifiedOfficialRows(BASE, status!);
    expect(next.unverifiedRows).toBe(2);
    expect(
      (await readMarketplaceSources()).officialSignature?.unverifiedRows
    ).toBe(2);
  });
});
