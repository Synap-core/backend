/**
 * Marketplace source verification — the trust checks on what a third-party
 * source serves, as PURE functions (bytes in, verdict out; the clock is a
 * parameter). The sync worker, the `marketplace.sources.*` add/re-approve
 * doors and the install door all call these, so "verified" means one thing.
 *
 * What a source serves (docs/marketplace-source.md):
 *   synap-index.json      the catalog, naming the key that signs it
 *   synap-index.json.sig  base64 ed25519 signature over the index's EXACT bytes
 *   <definitionUrl>       each package's definition; its sha256 is in the index
 *
 * The rules, in the order they are checked:
 *   1. size caps — an oversized index/definition is refused, never truncated;
 *   2. shape — `marketplaceIndexSchema` (@synap-core/types/marketplace-source);
 *   3. signature — against the PINNED key once a person confirmed one. An
 *      index that declares a different key and verifies under it is a KEY
 *      CHANGE (blocks the source until a person re-approves); one that does
 *      not verify is a bad signature (the last verified copy stays);
 *   4. expiry — an index past its `expires` is refused (a frozen copy cannot
 *      be replayed forever).
 *
 * Ed25519 via Node's built-in `crypto` — no dependency.
 */

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  MARKETPLACE_DEFINITION_MAX_BYTES,
  MARKETPLACE_INDEX_MAX_BYTES,
  marketplaceIndexSchema,
  type MarketplaceIndex,
} from "@synap-core/types/marketplace-source";

/** A raw 32-byte ed25519 public key (base64) as a Node key, or null when malformed. */
export function ed25519PublicKey(base64: string): KeyObject | null {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== base64) return null;
  try {
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
  } catch {
    return null;
  }
}

/** sha256 (hex) of the raw key bytes — what a person compares and the pod pins. */
export function keyFingerprint(base64: string): string {
  return createHash("sha256")
    .update(Buffer.from(base64, "base64"))
    .digest("hex");
}

/** sha256 (hex) of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Does `signature` (base64, surrounding whitespace ignored) verify `bytes`
 * under `publicKey`? False for anything malformed — never a throw.
 */
export function verifyEd25519(
  bytes: Uint8Array,
  signature: string,
  publicKey: string
): boolean {
  const key = ed25519PublicKey(publicKey);
  if (!key) return false;
  const sig = Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64) return false;
  try {
    return cryptoVerify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

export type IndexRejection =
  | "too_large"
  | "invalid"
  | "unsigned"
  | "bad_signature"
  | "expired"
  | "key_changed";

export type IndexVerdict =
  | {
      ok: true;
      index: MarketplaceIndex;
      /** The key the index is verified under; null for an unsigned listing. */
      publicKey: string | null;
      fingerprint: string | null;
    }
  | {
      ok: false;
      reason: IndexRejection;
      /** One plain sentence for the console. */
      message: string;
      /** key_changed: the key the index is signed by now (verified). */
      newPublicKey?: string;
      newFingerprint?: string;
    };

export interface VerifyIndexInput {
  indexBytes: Uint8Array;
  /** The `.sig` body, or null when the source serves none. */
  signature: string | null;
  /** The key a person confirmed; null on first add (they confirm the result). */
  pinnedKey: string | null;
  /** Refuse an index with no signature (every source but an unsigned showcase). */
  requireSignature: boolean;
  /** Once added, a source keeps its id — an index naming another is refused. */
  expectedSourceId?: string;
  now: Date;
  /** Override for tests only. */
  maxBytes?: number;
}

function reject(
  reason: IndexRejection,
  message: string,
  extra: { newPublicKey?: string; newFingerprint?: string } = {}
): IndexVerdict {
  return { ok: false, reason, message, ...extra };
}

/** Verify one index fetch. Pure; see the module doc for the rule order. */
export function verifyIndex(input: VerifyIndexInput): IndexVerdict {
  const max = input.maxBytes ?? MARKETPLACE_INDEX_MAX_BYTES;
  if (input.indexBytes.byteLength > max) {
    return reject(
      "too_large",
      `The index is larger than ${Math.round(max / 1024)} KB, so the pod did not read it.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.indexBytes)
    );
  } catch {
    return reject("invalid", "The index is not valid JSON.");
  }
  const parsed = marketplaceIndexSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
    return reject(
      "invalid",
      `The index is not in the synap-index.json format: ${issue?.message ?? "unknown problem"}${where}.`
    );
  }
  const index = parsed.data;
  if (input.expectedSourceId && index.source.id !== input.expectedSourceId) {
    return reject(
      "invalid",
      `The index now names itself "${index.source.id}", not "${input.expectedSourceId}".`
    );
  }

  const declared = index.source.publicKey ?? null;
  const signature = input.signature?.trim() || null;

  if (input.pinnedKey) {
    if (declared !== input.pinnedKey) {
      if (
        declared &&
        signature &&
        verifyEd25519(input.indexBytes, signature, declared)
      ) {
        return reject(
          "key_changed",
          "The source is now signed by a different key. Nothing installs from it until a pod admin compares the new fingerprint and re-approves.",
          { newPublicKey: declared, newFingerprint: keyFingerprint(declared) }
        );
      }
      return reject(
        "bad_signature",
        "The index is not signed by the key this pod trusts for this source."
      );
    }
    if (!signature || !verifyEd25519(input.indexBytes, signature, declared)) {
      return reject(
        "bad_signature",
        "The index signature does not match — it may have been altered."
      );
    }
  } else if (declared) {
    if (!signature || !verifyEd25519(input.indexBytes, signature, declared)) {
      return reject(
        "bad_signature",
        "The index names a signing key but its signature does not verify under it."
      );
    }
  } else if (input.requireSignature) {
    return reject(
      "unsigned",
      "The source is not signed. Only a showcase listing can be added without a signing key."
    );
  }

  if (new Date(index.expires).getTime() <= input.now.getTime()) {
    return reject(
      "expired",
      `The index expired on ${index.expires} — the source has to publish a fresh one.`
    );
  }

  // Only a key the signature was CHECKED under is reported (an unpinned
  // showcase with no key reports none).
  const verifiedKey = input.pinnedKey ?? declared;
  return {
    ok: true,
    index,
    publicKey: verifiedKey,
    fingerprint: verifiedKey ? keyFingerprint(verifiedKey) : null,
  };
}

export type DefinitionVerdict =
  | { ok: true; definition: Record<string, unknown> }
  | {
      ok: false;
      reason: "too_large" | "digest_mismatch" | "invalid";
      message: string;
    };

/**
 * Check a fetched definition against the digest its signed index lists, then
 * parse it. The digest is over the EXACT bytes, so it is checked before any
 * parse — a body that does not match is never read.
 */
export function verifyDefinitionBytes(
  bytes: Uint8Array,
  expectedSha256: string,
  maxBytes: number = MARKETPLACE_DEFINITION_MAX_BYTES
): DefinitionVerdict {
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      message: `The definition is larger than ${Math.round(maxBytes / 1024)} KB.`,
    };
  }
  if (sha256Hex(bytes) !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      reason: "digest_mismatch",
      message:
        "The definition does not match the digest the source signed — it was changed after publishing, so nothing was installed.",
    };
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        reason: "invalid",
        message: "The definition is not a JSON object.",
      };
    }
    return { ok: true, definition: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      reason: "invalid",
      message: "The definition is not valid JSON.",
    };
  }
}
