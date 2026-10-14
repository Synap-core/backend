/**
 * Field crypto against a REAL schema (PGlite): every ENCRYPTED_COLUMNS table
 * is created from its own `CREATE TABLE` in the hand-written migrations (found
 * by scanning `migrations/*.sql` for the registry's tables — derived, not
 * listed), then, with SYNAP_FIELD_KEYS set — the mode production switches to:
 *   - every registered cell exists in that schema;
 *   - values a live pod holds TODAY (service-key JSON, server-vault blobs,
 *     plaintext tokens, the OIDC secret inside pod_settings JSONB) still read;
 *   - a new write lands as an envelope bound to its row;
 *   - the audit counts per kid / legacy / plaintext, and skips client-mode
 *     vault rows (not this door's to read);
 *   - the sweep rewrites legacy, plaintext and older-kid values to the current
 *     kid (clearing iv/auth_tag, keeping JSONB siblings), never overwrites a
 *     row that changed under it, and reports an undecryptable row by id + code.
 * Keys are generated per run.
 */

import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createKeyring } from "@synap-core/field-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ENCRYPTED_COLUMNS } from "./encrypted-columns.js";
import {
  createPodFieldCrypto,
  type PodFieldCryptoConfig,
} from "./field-crypto.js";
import {
  auditEncryptedColumns,
  executorFor,
  reencryptColumns,
  type Exec,
} from "./field-crypto-sweep.js";

const MIGRATIONS = path.resolve(__dirname, "../../migrations");
const SERVICE_RAW = `test-service-${randomBytes(8).toString("hex")}`;
const VAULT_HEX = randomBytes(32).toString("hex");
const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");

function baseCfg(ring: string): PodFieldCryptoConfig {
  return {
    ring: createKeyring(ring),
    serviceKey: createHash("sha256").update(SERVICE_RAW).digest(),
    vaultKey: Buffer.from(VAULT_HEX, "hex"),
    allowLegacyPlaintext: true,
  };
}
const crypto = createPodFieldCrypto(baseCfg(`t2:${K2},t1:${K1}`));
const olderRing = createPodFieldCrypto(baseCfg(`t1:${K1}`));

/** HEAD `encryptServiceKey` (JSON {e,i,t}, sha256 of the raw env key). */
function headServiceKey(raw: string, plaintext: string): string {
  const k = createHash("sha256").update(raw).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const e = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return JSON.stringify({
    e: e.toString("base64"),
    i: iv.toString("base64"),
    t: c.getAuthTag().toString("base64"),
  });
}

/** HEAD `encryptServerSide` (base64 + iv + tag, hex VAULT_SERVER_KEY). */
function headVaultBlob(plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(VAULT_HEX, "hex"), iv);
  let encryptedData = c.update(plaintext, "utf8", "base64");
  encryptedData += c.final("base64");
  return {
    encryptedData,
    iv: iv.toString("base64"),
    authTag: c.getAuthTag().toString("base64"),
  };
}

/** The first `CREATE TABLE IF NOT EXISTS <table> (…);` in the migrations. */
function createStatement(table: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const re = new RegExp(
    `CREATE TABLE IF NOT EXISTS "?${table}"? \\([\\s\\S]*?\\n\\);`
  );
  for (const f of files) {
    const m = readFileSync(path.join(MIGRATIONS, f), "utf8").match(re);
    if (m) return m[0];
  }
  throw new Error(`no CREATE TABLE for ${table} in migrations/`);
}

const client = new PGlite();
const db = drizzle(client);
const exec: Exec = executorFor(db);
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  client.query<T>(sql, params).then((r) => r.rows);

const ID = {
  svcLegacy: "svc-legacy",
  svcOlder: "svc-older",
  svcBad: "svc-bad",
  prov: randomUUID(),
  cred: randomUUID(),
  vault: randomUUID(),
  vaultClient: randomUUID(),
  peer: randomUUID(),
  settings: randomUUID(),
};

beforeAll(async () => {
  // The baseline's enum types (a table may use one, e.g. secrets.type).
  const baseline = readFileSync(
    path.join(MIGRATIONS, "0000_baseline_schema.sql"),
    "utf8"
  );
  for (const m of baseline.matchAll(
    /DO \$\$ BEGIN\s+CREATE TYPE[\s\S]*?END; \$\$;/g
  )) {
    await client.exec(m[0]);
  }
  for (const table of new Set(ENCRYPTED_COLUMNS.map((e) => e.table))) {
    await client.exec(createStatement(table));
  }
  // What a live pod holds today, written the HEAD way.
  const svc = (id: string, key: string) =>
    q(
      `insert into intelligence_services (id, service_id, name, webhook_url, api_key) values ($1,$1,'IS','https://is.test',$2)`,
      [id, key]
    );
  await svc(ID.svcLegacy, headServiceKey(SERVICE_RAW, "is-key-legacy"));
  await svc(
    ID.svcOlder,
    olderRing.encryptField("is-key-older", {
      column: "intelligence_services.api_key",
      rowId: ID.svcOlder,
    })
  );
  // Written under another SYNAP_SERVICE_ENCRYPTION_KEY: unrecoverable.
  await svc(ID.svcBad, headServiceKey("another-raw-key", "is-key-lost"));
  await q(
    `insert into ai_providers (id, provider_id, name, base_url, api_key_env_var, encrypted_api_key) values ($1,'openrouter','OR','https://or.test','OPENROUTER_API_KEY',$2)`,
    [ID.prov, headServiceKey(SERVICE_RAW, "prov-key")]
  );
  await q(
    `insert into ai_provider_credentials (id, provider_id, user_id, encrypted_api_key, created_by) values ($1,'openrouter','u1',$2,'u1')`,
    [ID.cred, "cred-key-plaintext"]
  );
  const blob = headVaultBlob('{"token":"vault-v"}');
  await q(
    `insert into secrets (id, user_id, name, type, encrypted_data, iv, auth_tag, encryption_mode) values ($1,'u1','s','api_key',$2,$3,$4,'server')`,
    [ID.vault, blob.encryptedData, blob.iv, blob.authTag]
  );
  await q(
    `insert into secrets (id, user_id, name, type, encrypted_data, iv, auth_tag, encryption_mode) values ($1,'u1','c','api_key','client-ct','client-iv','client-tag','client')`,
    [ID.vaultClient]
  );
  await q(
    `insert into sync_peers (id, peer_pod_url, direction, auth_token) values ($1,'https://peer.test','push','peer-token-plain')`,
    [ID.peer]
  );
  await q(`insert into pod_settings (id, settings) values ($1,$2)`, [
    ID.settings,
    JSON.stringify({
      federationOidcClient: {
        clientId: "cid",
        clientSecret: "oidc-secret-plain",
        issuer: "https://cp.test",
      },
      intelligenceDefaults: { keep: true },
    }),
  ]);
}, 60_000);

afterAll(async () => {
  await client.close();
});

const byColumn = async () =>
  Object.fromEntries(
    (await auditEncryptedColumns(exec)).map((a) => [a.column, a.byKid])
  );

describe("pod field crypto on the real schema", () => {
  it("every registered cell is a text value in the migrated schema", async () => {
    for (const e of ENCRYPTED_COLUMNS) {
      const sqlColumn =
        e.storage.kind === "json" ? e.storage.jsonColumn : e.column;
      const rows = await q<{ data_type: string }>(
        `select data_type from information_schema.columns where table_name = $1 and column_name = $2`,
        [e.table, sqlColumn]
      );
      expect(rows.map((r) => r.data_type)).toEqual([
        e.storage.kind === "json" ? "jsonb" : "text",
      ]);
    }
  });

  it("today's values read through the door", () => {
    expect(
      crypto.resolveField(headServiceKey(SERVICE_RAW, "x"), {
        column: "intelligence_services.api_key",
        rowId: ID.svcLegacy,
      })
    ).toBe("x");
  });

  it("audit: counts per kid / legacy / plaintext; client vault rows are not counted", async () => {
    expect(await byColumn()).toEqual({
      "intelligence_services.api_key": { legacy: 2, t1: 1 },
      "ai_providers.encrypted_api_key": { legacy: 1 },
      "ai_provider_credentials.encrypted_api_key": { plaintext: 1 },
      "secrets.encrypted_data": { legacy: 1 },
      "sync_peers.auth_token": { plaintext: 1 },
      "pod_settings.federation_oidc_client_secret": { plaintext: 1 },
    });
  });

  it("a dry run decrypts and counts, writes nothing", async () => {
    const before = await byColumn();
    const res = await reencryptColumns(exec, crypto, { dryRun: true });
    expect(res.reduce((n, r) => n + r.rewritten, 0)).toBe(0);
    expect(await byColumn()).toEqual(before);
  });

  it("a row that changed under the sweep is skipped, never overwritten", async () => {
    let raced = false;
    const racing: Exec = async (query) => {
      const text = JSON.stringify(query);
      if (!raced && text.includes("UPDATE") && text.includes("sync_peers")) {
        raced = true;
        await q(
          `update sync_peers set auth_token = 'rotated-meanwhile' where id = $1`,
          [ID.peer]
        );
      }
      return exec(query);
    };
    const [r] = await reencryptColumns(racing, crypto, {
      columns: ENCRYPTED_COLUMNS.filter((e) => e.table === "sync_peers"),
    });
    expect(raced).toBe(true);
    expect(r!.skippedConcurrent).toBe(1);
    expect(r!.rewritten).toBe(0);
    const [row] = await q<{ auth_token: string }>(
      `select auth_token from sync_peers where id = $1`,
      [ID.peer]
    );
    expect(row!.auth_token).toBe("rotated-meanwhile");
  });

  it("the sweep moves every readable value to the current kid", async () => {
    const res = await reencryptColumns(exec, crypto, { batchSize: 1 });
    const failed = res.flatMap((r) => r.failed);
    expect(failed).toEqual([{ rowId: ID.svcBad, code: "DECRYPT_FAILED" }]);
    expect(await byColumn()).toEqual({
      "intelligence_services.api_key": { legacy: 1, t2: 2 },
      "ai_providers.encrypted_api_key": { t2: 1 },
      "ai_provider_credentials.encrypted_api_key": { t2: 1 },
      "secrets.encrypted_data": { t2: 1 },
      "sync_peers.auth_token": { t2: 1 },
      "pod_settings.federation_oidc_client_secret": { t2: 1 },
    });
  });

  it("rewritten values decrypt to the same secrets, bound to their own rows", async () => {
    const one = async (sql: string, id: string) =>
      (await q<{ v: string }>(sql, [id]))[0]!.v;
    const svc = await one(
      `select api_key as v from intelligence_services where id = $1`,
      ID.svcLegacy
    );
    expect(
      crypto.decryptField(svc, {
        column: "intelligence_services.api_key",
        rowId: ID.svcLegacy,
      })
    ).toBe("is-key-legacy");
    expect(() =>
      crypto.decryptField(svc, {
        column: "intelligence_services.api_key",
        rowId: ID.svcOlder,
      })
    ).toThrow();
    expect(
      crypto.decryptField(
        await one(
          `select encrypted_api_key as v from ai_provider_credentials where id = $1`,
          ID.cred
        ),
        { column: "ai_provider_credentials.encrypted_api_key", rowId: ID.cred }
      )
    ).toBe("cred-key-plaintext");
    expect(
      crypto.decryptField(
        await one(
          `select auth_token as v from sync_peers where id = $1`,
          ID.peer
        ),
        { column: "sync_peers.auth_token", rowId: ID.peer }
      )
    ).toBe("rotated-meanwhile");

    const [vault] = await q<{
      encrypted_data: string;
      iv: string;
      auth_tag: string;
    }>(`select encrypted_data, iv, auth_tag from secrets where id = $1`, [
      ID.vault,
    ]);
    expect(vault!.iv).toBe("");
    expect(vault!.auth_tag).toBe("");
    expect(
      crypto.decryptBlob(
        {
          encryptedData: vault!.encrypted_data,
          iv: vault!.iv,
          authTag: vault!.auth_tag,
        },
        { column: "secrets.encrypted_data", rowId: ID.vault }
      )
    ).toBe('{"token":"vault-v"}');
    const [clientRow] = await q<{ encrypted_data: string }>(
      `select encrypted_data from secrets where id = $1`,
      [ID.vaultClient]
    );
    expect(clientRow!.encrypted_data).toBe("client-ct");

    const [settings] = await q<{ settings: Record<string, any> }>(
      `select settings from pod_settings where id = $1`,
      [ID.settings]
    );
    expect(settings!.settings.intelligenceDefaults).toEqual({ keep: true });
    expect(settings!.settings.federationOidcClient.clientId).toBe("cid");
    expect(
      crypto.resolveField(
        settings!.settings.federationOidcClient.clientSecret,
        {
          column: "pod_settings.federation_oidc_client_secret",
          rowId: ID.settings,
        }
      )
    ).toBe("oidc-secret-plain");
  });

  it("a new write is an envelope under the current kid", async () => {
    const id = randomUUID();
    await q(
      `insert into sync_peers (id, peer_pod_url, direction, auth_token) values ($1,'https://p2.test','pull',$2)`,
      [
        id,
        crypto.encryptField("fresh", {
          column: "sync_peers.auth_token",
          rowId: id,
        }),
      ]
    );
    expect((await byColumn())["sync_peers.auth_token"]).toEqual({ t2: 2 });
  });
});
