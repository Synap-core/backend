/**
 * The pod's field-crypto door (`field-crypto.ts`) over `@synap-core/field-crypto`:
 * envelope writes bound to their cell, the two pre-keyring formats still
 * readable, today's formats kept while SYNAP_FIELD_KEYS is unset, and the
 * plaintext flag. Keys are generated per run; the "HEAD" helpers re-implement
 * the pre-keyring writers exactly as they were, so a legacy value here is
 * byte-for-byte what a live pod holds.
 */

import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring, FieldCryptoError } from "@synap-core/field-crypto";

import {
  createPodFieldCrypto,
  podFieldCrypto,
  podFieldCryptoFromEnv,
  rebindField,
  resolveField,
  type PodFieldCryptoConfig,
} from "./field-crypto.js";
import {
  decryptServerSide,
  encryptServerSide,
  isServerVaultAvailable,
} from "./server-vault.js";
import { resolveServiceKey } from "./service-key-crypto.js";

const key = () => randomBytes(32).toString("base64");
const SERVICE_RAW = `test-service-${randomBytes(8).toString("hex")}`;
const VAULT_HEX = randomBytes(32).toString("hex");
const K1 = key();
const K2 = key();

/** HEAD `encryptServiceKey`: JSON {e,i,t} under sha256(raw), no AAD. */
function headServiceKey(raw: string, plaintext: string, ivField = "i"): string {
  const k = createHash("sha256").update(raw).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const e = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return JSON.stringify({
    e: e.toString("base64"),
    [ivField]: iv.toString("base64"),
    t: c.getAuthTag().toString("base64"),
  });
}

/** HEAD `encryptServerSide`: base64 blob under the hex VAULT_SERVER_KEY. */
function headVaultBlob(hex: string, plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  let encryptedData = c.update(plaintext, "utf8", "base64");
  encryptedData += c.final("base64");
  return {
    encryptedData,
    iv: iv.toString("base64"),
    authTag: c.getAuthTag().toString("base64"),
  };
}

function cfg(over: Partial<PodFieldCryptoConfig> = {}): PodFieldCryptoConfig {
  return {
    ring: createKeyring(`k2:${K2},k1:${K1}`),
    serviceKey: createHash("sha256").update(SERVICE_RAW).digest(),
    vaultKey: Buffer.from(VAULT_HEX, "hex"),
    allowLegacyPlaintext: true,
    ...over,
  };
}

const svcRef = (rowId: string) =>
  ({ column: "intelligence_services.api_key", rowId }) as const;
const peerRef = (rowId: string) =>
  ({ column: "sync_peers.auth_token", rowId }) as const;
const vaultRef = (rowId: string) =>
  ({ column: "secrets.encrypted_data", rowId }) as const;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as FieldCryptoError).code;
  }
  return undefined;
}

describe("pod field-crypto — envelope (SYNAP_FIELD_KEYS set)", () => {
  const c = createPodFieldCrypto(cfg());

  it("writes a v1 envelope under the first kid and reads it back", () => {
    const row = randomUUID();
    const stored = c.encryptField("sk-test-123", svcRef(row));
    expect(stored.startsWith("senc:1:k2:")).toBe(true);
    expect(stored).not.toContain("sk-test-123");
    expect(c.decryptField(stored, svcRef(row))).toBe("sk-test-123");
    expect(c.currentKid).toBe("k2");
  });

  it("binds a value to its row AND its column (AAD)", () => {
    const row = randomUUID();
    const stored = c.encryptField("sk-test-123", svcRef(row));
    expect(codeOf(() => c.decryptField(stored, svcRef(randomUUID())))).toBe(
      "DECRYPT_FAILED"
    );
    expect(
      codeOf(() =>
        c.decryptField(stored, {
          column: "ai_providers.encrypted_api_key",
          rowId: row,
        })
      )
    ).toBe("DECRYPT_FAILED");
  });

  it("reads values under an older kid of the ring", () => {
    const old = createPodFieldCrypto(cfg({ ring: createKeyring(`k1:${K1}`) }));
    const row = randomUUID();
    const stored = old.encryptField("v-old", svcRef(row));
    expect(stored.startsWith("senc:1:k1:")).toBe(true);
    expect(c.decryptField(stored, svcRef(row))).toBe("v-old");
    expect(c.needsReencrypt(stored)).toBe(true);
  });

  it("vault blobs: envelope in encryptedData, iv/authTag empty, row-bound", () => {
    const row = randomUUID();
    const blob = c.encryptBlob('{"k":"v"}', vaultRef(row));
    expect(blob.encryptedData.startsWith("senc:1:k2:")).toBe(true);
    expect(blob.iv).toBe("");
    expect(blob.authTag).toBe("");
    expect(c.decryptBlob(blob, vaultRef(row))).toBe('{"k":"v"}');
    expect(codeOf(() => c.decryptBlob(blob, vaultRef(randomUUID())))).toBe(
      "DECRYPT_FAILED"
    );
  });

  it("refuses a reserved kid and a ring whose key is not 32 bytes", () => {
    expect(
      codeOf(() =>
        createPodFieldCrypto(cfg({ ring: createKeyring(`legacy:${K1}`) }))
      )
    ).toBe("INVALID_KEYRING");
    expect(codeOf(() => createKeyring("k1:dG9vLXNob3J0"))).toBe(
      "INVALID_KEYRING"
    );
  });

  it("a text door refuses a vault-blob cell and vice versa", () => {
    expect(
      codeOf(() => c.encryptField("x", vaultRef(randomUUID()) as never))
    ).toBe("INVALID_AAD");
  });

  it("rebindField moves a ciphertext to the row it lands in", () => {
    const prev = process.env.SYNAP_FIELD_KEYS;
    process.env.SYNAP_FIELD_KEYS = `k2:${K2}`;
    try {
      const a = randomUUID();
      const b = randomUUID();
      const stored = podFieldCrypto().encryptField("sk-move", {
        column: "ai_providers.encrypted_api_key",
        rowId: a,
      });
      const moved = rebindField(stored, {
        column: "ai_providers.encrypted_api_key",
        fromRowId: a,
        rowId: b,
      });
      expect(
        resolveField(moved, {
          column: "ai_providers.encrypted_api_key",
          rowId: b,
        })
      ).toBe("sk-move");
      expect(
        rebindField(stored, {
          column: "ai_providers.encrypted_api_key",
          fromRowId: a,
          rowId: a,
        })
      ).toBe(stored);
    } finally {
      if (prev === undefined) delete process.env.SYNAP_FIELD_KEYS;
      else process.env.SYNAP_FIELD_KEYS = prev;
    }
  });
});

describe("pod field-crypto — legacy formats stay readable", () => {
  for (const [label, ring] of [
    ["with SYNAP_FIELD_KEYS set", cfg().ring],
    ["with SYNAP_FIELD_KEYS unset", null],
  ] as const) {
    const c = createPodFieldCrypto(cfg({ ring }));

    it(`service-key JSON {e,i,t} and {e,iv,t} (${label})`, () => {
      const row = randomUUID();
      expect(
        c.decryptField(headServiceKey(SERVICE_RAW, "sk-legacy"), svcRef(row))
      ).toBe("sk-legacy");
      expect(
        c.decryptField(
          headServiceKey(SERVICE_RAW, "sk-legacy-iv", "iv"),
          svcRef(row)
        )
      ).toBe("sk-legacy-iv");
    });

    it(`server-vault blob under VAULT_SERVER_KEY (${label})`, () => {
      expect(
        c.decryptBlob(
          headVaultBlob(VAULT_HEX, "vault-legacy"),
          vaultRef(randomUUID())
        )
      ).toBe("vault-legacy");
    });
  }

  it("a legacy value under a different key fails with DECRYPT_FAILED, no secret in the message", () => {
    const c = createPodFieldCrypto(cfg());
    let err: FieldCryptoError | undefined;
    try {
      c.decryptField(headServiceKey("another-raw", "sk-other"), svcRef("r"));
    } catch (e) {
      err = e as FieldCryptoError;
    }
    expect(err?.code).toBe("DECRYPT_FAILED");
    expect(err?.message).not.toContain("sk-other");
    expect(err?.message).not.toContain(SERVICE_RAW);
  });

  it("a legacy value with its key gone is UNKNOWN_KID", () => {
    const c = createPodFieldCrypto(cfg({ serviceKey: null, vaultKey: null }));
    expect(
      codeOf(() =>
        c.decryptField(headServiceKey(SERVICE_RAW, "x"), svcRef("r"))
      )
    ).toBe("UNKNOWN_KID");
    expect(
      codeOf(() => c.decryptBlob(headVaultBlob(VAULT_HEX, "x"), vaultRef("r")))
    ).toBe("UNKNOWN_KID");
  });

  it("a '{' value that is not the legacy shape is malformed, never a credential", () => {
    const c = createPodFieldCrypto(cfg());
    expect(codeOf(() => c.resolveField('{"e":"x"}', svcRef("r")))).toBe(
      "MALFORMED_ENVELOPE"
    );
  });
});

describe("pod field-crypto — SYNAP_FIELD_KEYS unset keeps today's formats", () => {
  const c = createPodFieldCrypto(cfg({ ring: null }));

  it("service-key cells: HEAD's JSON {e,i,t}, readable by HEAD's algorithm", () => {
    const stored = c.encryptField("sk-today", svcRef(randomUUID()));
    const p = JSON.parse(stored) as { e: string; i: string; t: string };
    expect(Object.keys(p).sort()).toEqual(["e", "i", "t"]);
    // Readable without any AAD, under sha256(SYNAP_SERVICE_ENCRYPTION_KEY).
    expect(
      createPodFieldCrypto(cfg({ ring: null })).decryptField(
        stored,
        svcRef("any-other-row")
      )
    ).toBe("sk-today");
  });

  it("plaintext cells stay plaintext; vault blobs keep {base64, iv, tag}", () => {
    expect(c.encryptField("tok-today", peerRef(randomUUID()))).toBe(
      "tok-today"
    );
    const blob = c.encryptBlob("v", vaultRef(randomUUID()));
    expect(blob.iv.length).toBeGreaterThan(0);
    expect(blob.authTag.length).toBeGreaterThan(0);
    expect(blob.encryptedData.startsWith("senc:")).toBe(false);
  });

  it("an envelope with no ring is UNKNOWN_KID, not plaintext", () => {
    const enc = createPodFieldCrypto(cfg()).encryptField("x", svcRef("r"));
    expect(codeOf(() => c.resolveField(enc, svcRef("r")))).toBe("UNKNOWN_KID");
  });
});

describe("pod field-crypto — legacy plaintext flag", () => {
  it("resolveField accepts plaintext while the flag is on", () => {
    const c = createPodFieldCrypto(cfg({ allowLegacyPlaintext: true }));
    expect(c.resolveField("tok-plain", peerRef("p1"))).toBe("tok-plain");
  });

  it("resolveField refuses plaintext once the flag is off", () => {
    const c = createPodFieldCrypto(cfg({ allowLegacyPlaintext: false }));
    expect(codeOf(() => c.resolveField("tok-plain", peerRef("p1")))).toBe(
      "NOT_AN_ENVELOPE"
    );
  });

  it("decryptField never accepts plaintext", () => {
    const c = createPodFieldCrypto(cfg({ allowLegacyPlaintext: true }));
    expect(codeOf(() => c.decryptField("tok-plain", peerRef("p1")))).toBe(
      "NOT_AN_ENVELOPE"
    );
  });

  it("the env flag is on unless explicitly false", () => {
    const base = {
      SYNAP_FIELD_KEYS: `k1:${K1}`,
      VAULT_SERVER_KEY: VAULT_HEX,
    };
    expect(podFieldCryptoFromEnv(base).resolveField("p", peerRef("x"))).toBe(
      "p"
    );
    expect(
      codeOf(() =>
        podFieldCryptoFromEnv({
          ...base,
          SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT: "false",
        }).resolveField("p", peerRef("x"))
      )
    ).toBe("NOT_AN_ENVELOPE");
  });
});

describe("named doors read env per call", () => {
  const saved = {
    SYNAP_FIELD_KEYS: process.env.SYNAP_FIELD_KEYS,
    SYNAP_SERVICE_ENCRYPTION_KEY: process.env.SYNAP_SERVICE_ENCRYPTION_KEY,
    VAULT_SERVER_KEY: process.env.VAULT_SERVER_KEY,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("server-vault: legacy write before the ring, envelope after, both readable", () => {
    delete process.env.SYNAP_FIELD_KEYS;
    process.env.VAULT_SERVER_KEY = VAULT_HEX;
    const row = randomUUID();
    const legacy = encryptServerSide("before", vaultRef(row));
    expect(legacy.iv).not.toBe("");
    expect(isServerVaultAvailable()).toBe(true);

    process.env.SYNAP_FIELD_KEYS = `k2:${K2}`;
    const env = encryptServerSide("after", vaultRef(row));
    expect(env.encryptedData.startsWith("senc:1:k2:")).toBe(true);
    expect(decryptServerSide(legacy, vaultRef(row))).toBe("before");
    expect(decryptServerSide(env, vaultRef(row))).toBe("after");

    delete process.env.VAULT_SERVER_KEY;
    expect(isServerVaultAvailable()).toBe(true); // the ring alone suffices
  });

  it("service-key: resolveServiceKey reads HEAD's JSON through the door", () => {
    delete process.env.SYNAP_FIELD_KEYS;
    process.env.SYNAP_SERVICE_ENCRYPTION_KEY = SERVICE_RAW;
    expect(
      resolveServiceKey(headServiceKey(SERVICE_RAW, "sk-door"), svcRef("r"))
    ).toBe("sk-door");
  });
});
