/**
 * The TEST-ONLY catalog signing keys, refused wherever this pod trusts a key.
 *
 * The Control Plane's contract fixtures are signed with ed25519 keys whose
 * private halves are `sha256("<prefix><label>")` over the public labels below
 * (control-plane-api `src/lib/catalog-signing/test-only-keys.ts`). Anyone can
 * recompute them. Their public halves sit in both repos, in exactly the shape
 * a release needs (`fixtures/official-catalog-cp/contract.json`), so one pasted
 * into the compiled roots or `SYNAP_CATALOG_PUBLIC_KEYS` would let anyone sign
 * a keys statement and any index. The deny list is DERIVED from the labels
 * here; `official-catalog-cp-contract.test.ts` pins it against the fixture
 * contract, so a fixture key added on the CP side fails there until it is
 * listed here too.
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

export const TEST_ONLY_CATALOG_KEY_SEED_PREFIX =
  "synap-catalog-signing TEST ONLY — never trusted: ";

export const TEST_ONLY_CATALOG_KEY_LABELS = [
  "root (current)",
  "root (standby)",
  "online catalog key",
  "next online catalog key",
] as const;

/** PKCS#8 DER header for an ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

function testOnlyPublicKey(label: string): string {
  const seed = createHash("sha256")
    .update(`${TEST_ONLY_CATALOG_KEY_SEED_PREFIX}${label}`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as {
    x: string;
  };
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** The raw ed25519 public keys (base64) of every TEST-ONLY label. */
export const TEST_ONLY_CATALOG_PUBLIC_KEYS: readonly string[] = Object.freeze(
  TEST_ONLY_CATALOG_KEY_LABELS.map(testOnlyPublicKey)
);

const DENIED = new Set(TEST_ONLY_CATALOG_PUBLIC_KEYS);

/** Is this public key one of the TEST-ONLY fixture keys (never trusted)? */
export function isTestOnlyCatalogKey(publicKey: string): boolean {
  return DENIED.has(publicKey.trim());
}
