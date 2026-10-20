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
 *      be replayed forever), and so is one whose `expires` is more than
 *      `MARKETPLACE_INDEX_MAX_LIFETIME_DAYS` ahead (a source re-signs at least
 *      that often, so a copy captured today is dead within a month);
 *   5. freshness — once the pod accepted an index, an index that expires
 *      EARLIER than it is refused: the pod never steps back to an older,
 *      still-valid copy a mirror or a man-in-the-middle replays. `expires` is
 *      the index's own clock, so it is the monotonic stamp (the format carries
 *      no separate issue time).
 *
 * Synap's own catalog goes through the SAME index checks
 * (`verifyOfficialIndex`): its index must be signed by one of the online
 * catalog keys a keys statement names, and that statement by one of the root
 * keys compiled into the pod (`verifyKeysStatement`) — or, on a private
 * mirror, by a key the operator set. Its listings carry a content digest the
 * pod recomputes from the definitions the Control Plane's endpoints serve
 * (`officialContentHash`, `checkOfficialListing`).
 *
 * Ed25519 via Node's built-in `crypto` — no dependency.
 */

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { z } from "zod";
import {
  CATALOG_KEY_MAX_LIFETIME_DAYS,
  CATALOG_KEYS_MAX_BYTES,
  CATALOG_KEYS_MAX_LIFETIME_DAYS,
  MARKETPLACE_DEFINITION_MAX_BYTES,
  MARKETPLACE_INDEX_MAX_BYTES,
  canonicalDefinitionJson,
  catalogKeysStatementSchema,
  marketplaceIndexSchema,
  officialIndexSchema,
  type CatalogKeysStatement,
  type MarketplaceIndex,
  type MarketplacePackageKind,
  type OfficialIndex,
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

/** How far ahead an index may say it stays valid. */
export const MARKETPLACE_INDEX_MAX_LIFETIME_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = MARKETPLACE_INDEX_MAX_LIFETIME_DAYS * DAY_MS;

export type IndexRejection =
  | "too_large"
  | "invalid"
  | "unsigned"
  | "bad_signature"
  | "expired"
  | "replayed"
  | "key_changed";

export type IndexVerdict<I = MarketplaceIndex> =
  | {
      ok: true;
      index: I;
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
  /**
   * `expires` of the last index the pod accepted from this source; an index
   * that expires earlier is an older copy and is refused.
   */
  lastAcceptedExpires?: string | null;
  now: Date;
  /** Override for tests only. */
  maxBytes?: number;
}

function reject(
  reason: IndexRejection,
  message: string,
  extra: { newPublicKey?: string; newFingerprint?: string } = {}
): { ok: false; reason: IndexRejection; message: string } {
  return { ok: false, reason, message, ...extra };
}

/** Verify one index fetch. Pure; see the module doc for the rule order. */
export function verifyIndex(input: VerifyIndexInput): IndexVerdict {
  return verifyIndexWith(marketplaceIndexSchema, input);
}

export interface VerifyOfficialIndexInput {
  indexBytes: Uint8Array;
  signature: string | null;
  /** The online catalog keys a verified keys statement names, or the operator's keys. */
  trustedKeys: readonly string[];
  lastAcceptedExpires?: string | null;
  /** `SYNAP_CATALOG_ALLOW_EXPIRED`: an index past its `expires` is still accepted. */
  allowExpired?: boolean;
  now: Date;
}

/**
 * Verify Synap's own index: the same rules as any source, but against a SET
 * of trusted keys (any of them may sign) and in the official format. There is
 * no "key changed" outcome — a new key arrives through a new keys statement,
 * so an index under any other key is a bad signature.
 */
export function verifyOfficialIndex(
  input: VerifyOfficialIndexInput
): IndexVerdict<OfficialIndex> {
  return verifyIndexWith(officialIndexSchema, {
    indexBytes: input.indexBytes,
    signature: input.signature,
    pinnedKey: null,
    trustedKeys: input.trustedKeys,
    requireSignature: true,
    lastAcceptedExpires: input.lastAcceptedExpires,
    allowExpired: input.allowExpired,
    now: input.now,
  });
}

function verifyIndexWith<
  S extends z.ZodType<{
    source: { id: string; publicKey?: string };
    expires: string;
  }>,
>(
  schema: S,
  input: VerifyIndexInput & {
    trustedKeys?: readonly string[];
    allowExpired?: boolean;
  }
): IndexVerdict<z.infer<S>> {
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
  const parsed = schema.safeParse(raw);
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

  if (input.trustedKeys) {
    if (
      !declared ||
      !input.trustedKeys.includes(declared) ||
      !signature ||
      !verifyEd25519(input.indexBytes, signature, declared)
    ) {
      return reject(
        "bad_signature",
        "The index is not signed by a key this pod trusts for it."
      );
    }
  } else if (input.pinnedKey) {
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

  const expires = new Date(index.expires).getTime();
  if (expires <= input.now.getTime() && !input.allowExpired) {
    return reject(
      "expired",
      `The index expired on ${index.expires} — the source has to publish a fresh one.`
    );
  }
  if (expires - input.now.getTime() > MAX_LIFETIME_MS) {
    return reject(
      "invalid",
      `The index says it stays valid until ${index.expires}, more than ${MARKETPLACE_INDEX_MAX_LIFETIME_DAYS} days ahead. A source signs a fresh index at least every ${MARKETPLACE_INDEX_MAX_LIFETIME_DAYS} days.`
    );
  }
  // A floor further ahead than any index may now reach was accepted before
  // the lifetime cap existed; honouring it would lock the source out.
  const floor = input.lastAcceptedExpires
    ? new Date(input.lastAcceptedExpires).getTime()
    : Number.NaN;
  if (
    Number.isFinite(floor) &&
    floor - input.now.getTime() <= MAX_LIFETIME_MS &&
    expires < floor
  ) {
    return reject(
      "replayed",
      "The source served an older copy of its index than the one this pod already has, so the pod kept the newer one."
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

export type KeysStatementVerdict =
  | {
      ok: true;
      statement: CatalogKeysStatement;
      /** The online catalog keys usable now. */
      keys: string[];
      /** Fingerprint of the root key that signed the statement. */
      rootFingerprint: string;
    }
  | {
      ok: false;
      reason:
        "too_large" | "invalid" | "bad_signature" | "expired" | "replayed";
      message: string;
    };

export interface VerifyKeysStatementInput {
  statementBytes: Uint8Array;
  signature: string | null;
  /** The root keys compiled into this pod release. */
  rootKeys: readonly string[];
  /** `version` of the last statement this pod accepted. */
  lastVersion?: number | null;
  /**
   * `SYNAP_CATALOG_ALLOW_EXPIRED` (air-gapped pods). Honoured only over a
   * `lastVersion` floor, for a statement at or above it: past expiry, only
   * the freshness floor still keeps a retired key out, so with no floor an
   * expired statement is refused like any other.
   */
  allowExpired?: boolean;
  now: Date;
}

/**
 * Verify the keys statement that names Synap's online catalog keys. Pure.
 *   1. size cap and shape (`catalogKeysStatementSchema`);
 *   2. signature — over the exact bytes, by ANY root key compiled in;
 *   3. expiry — refused once past `expires` (unless `allowExpired` over a
 *      `lastVersion` floor the statement meets), and when `expires` is more
 *      than `CATALOG_KEYS_MAX_LIFETIME_DAYS` ahead;
 *   4. freshness — `version` never moves back (an older statement, still
 *      signed and unexpired, cannot be replayed to bring back a retired key);
 *   5. the keys — only those whose `notAfter` is still ahead and at most
 *      `CATALOG_KEY_MAX_LIFETIME_DAYS` away count: an online key is
 *      short-lived by rule, so a long-lived one is never trusted.
 */
export function verifyKeysStatement(
  input: VerifyKeysStatementInput
): KeysStatementVerdict {
  const fail = (
    reason: Exclude<KeysStatementVerdict, { ok: true }>["reason"],
    message: string
  ): KeysStatementVerdict => ({ ok: false, reason, message });
  if (input.statementBytes.byteLength > CATALOG_KEYS_MAX_BYTES) {
    return fail(
      "too_large",
      "The catalog keys statement is too large to read."
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.statementBytes)
    );
  } catch {
    return fail("invalid", "The catalog keys statement is not valid JSON.");
  }
  const parsed = catalogKeysStatementSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "invalid",
      "The catalog keys statement is not in the synap-catalog-keys.json format."
    );
  }
  const statement = parsed.data;
  const signature = input.signature?.trim() || null;
  const root = signature
    ? input.rootKeys.find((key) =>
        verifyEd25519(input.statementBytes, signature, key)
      )
    : undefined;
  if (!root) {
    return fail(
      "bad_signature",
      "The catalog keys statement is not signed by a Synap root key this pod trusts."
    );
  }
  const now = input.now.getTime();
  const expires = new Date(statement.expires).getTime();
  // An expired statement (or key) is only ever taken over a freshness floor:
  // without one, a replayed old statement could bring back a retired key.
  const allowExpired =
    input.allowExpired === true &&
    typeof input.lastVersion === "number" &&
    statement.version >= input.lastVersion;
  if (expires <= now && !allowExpired) {
    return fail(
      "expired",
      `The catalog keys statement expired on ${statement.expires}.`
    );
  }
  if (expires - now > CATALOG_KEYS_MAX_LIFETIME_DAYS * DAY_MS) {
    return fail(
      "invalid",
      `The catalog keys statement says it stays valid more than ${CATALOG_KEYS_MAX_LIFETIME_DAYS} days ahead.`
    );
  }
  if (
    typeof input.lastVersion === "number" &&
    statement.version < input.lastVersion
  ) {
    return fail(
      "replayed",
      "The Control Plane served an older catalog keys statement than the one this pod already has."
    );
  }
  const keys = statement.keys
    .filter((k) => {
      const notAfter = new Date(k.notAfter).getTime();
      return (
        (notAfter > now || allowExpired) &&
        notAfter - now <= CATALOG_KEY_MAX_LIFETIME_DAYS * DAY_MS
      );
    })
    .map((k) => k.publicKey);
  if (keys.length === 0) {
    return fail(
      "invalid",
      `The catalog keys statement names no catalog key valid now for at most ${CATALOG_KEY_MAX_LIFETIME_DAYS} days.`
    );
  }
  return {
    ok: true,
    statement,
    keys,
    rootFingerprint: keyFingerprint(root),
  };
}

/** sha256 (hex) of an official definition's canonical JSON — what Synap's index lists. */
export function officialContentHash(
  kind: MarketplacePackageKind,
  definition: Record<string, unknown>
): string {
  return sha256Hex(
    new TextEncoder().encode(canonicalDefinitionJson(kind, definition))
  );
}

/** What Synap's verified index lists for one (kind, slug). */
export interface OfficialListedDigest {
  version: string;
  contentHash: string;
}

/**
 * Does Synap's verified index vouch for this definition? Null when it does,
 * else one plain sentence. Pure. The digest covers the content, not `_meta`,
 * so a `_meta.slug` naming another package (the identity an install is
 * stamped with) is refused here too. `version` is the version the caller is
 * about to install or converge to, when it knows one.
 */
export function checkOfficialListing(input: {
  kind: MarketplacePackageKind;
  slug: string;
  version: string | null;
  definition: Record<string, unknown>;
  listed: OfficialListedDigest | null;
}): string | null {
  const name = `"${input.slug}"`;
  if (!input.listed) {
    return `${name} is not in Synap's signed catalog.`;
  }
  if (input.version && input.version !== input.listed.version) {
    return `${name} ${input.version} is not the version Synap's signed catalog lists (${input.listed.version}).`;
  }
  const meta = input.definition._meta;
  const metaSlug =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).slug
      : undefined;
  if (metaSlug !== undefined && metaSlug !== input.slug) {
    return `${name} names itself "${String(metaSlug)}" — not what Synap's signed catalog lists.`;
  }
  if (
    officialContentHash(input.kind, input.definition) !==
    input.listed.contentHash
  ) {
    return `${name} doesn't match the digest Synap signed — it was changed after publishing.`;
  }
  return null;
}
