/**
 * The Control Plane's TEST-ONLY catalog keys, refused wherever this pod trusts
 * a catalog key (the compiled roots and SYNAP_CATALOG_PUBLIC_KEYS).
 *
 * Each is derived from a public label (control-plane-api
 * `src/lib/catalog-signing/test-only-keys.ts`): its private half is
 * `sha256(<prefix><label>)`, so anyone can recompute it. They sign the
 * committed contract fixtures and nothing else. Derived here the same way
 * rather than copied; `official-catalog-cp-contract.test.ts` pins the prefix,
 * the labels and the keys against the fixtures' own `contract.json`, so a key
 * added on the CP side fails there until it is listed here too.
 *
 * Dependency-free (node:crypto only), so a unit test can read it without the
 * database the signature worker needs.
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

/** What each label's seed starts with. */
export const TEST_ONLY_KEY_SEED_PREFIX =
  "synap-catalog-signing TEST ONLY — never trusted: ";

export const TEST_ONLY_KEY_LABELS = [
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
    .update(`${TEST_ONLY_KEY_SEED_PREFIX}${label}`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const { x } = createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(x ?? "", "base64url").toString("base64");
}

/** The test-only public keys (raw ed25519, base64), in label order. Never a trust anchor. */
export const TEST_ONLY_PUBLIC_KEYS: readonly string[] = Object.freeze(
  TEST_ONLY_KEY_LABELS.map(testOnlyPublicKey)
);

export const CATALOG_TEST_ONLY_KEYS: ReadonlySet<string> = new Set(
  TEST_ONLY_PUBLIC_KEYS
);
