/**
 * Synap's own catalog, signed — the check that runs with every official
 * catalog sync (docs/architecture/official-catalog-signing.md).
 *
 * The Control Plane keeps serving its catalog endpoints; beside them it
 * serves a signed index of package digests. Trust comes from keys, never
 * from the host:
 *
 *   root keys (offline, compiled into the pod release: current + standby)
 *     └─ sign synap-catalog-keys.json — the online catalog keys, ≤90 days each
 *          └─ sign synap-index.json — every package's content digest
 *
 * or, on a private mirror, keys the operator sets (`SYNAP_CATALOG_PUBLIC_KEYS`)
 * that sign the index directly. Nothing is ever trusted on first fetch.
 *
 * A verified index replaces `official_catalog_digests`; a failed one leaves
 * it as it was (never wiped) and records why. What a failure or a lapsed
 * index means for installs is decided by `officialCatalogStanding`
 * (@synap-core/types/marketplace-source): only REPORTED until enforcement is
 * switched on, and never anything while no trust anchor is configured.
 */

import {
  db,
  and,
  eq,
  readOfficialCatalogDigests,
  recordOfficialCatalogSignature,
  replaceOfficialCatalogDigests,
  type OfficialCatalogSignature,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createLogger } from "@synap-core/core";
import {
  MARKETPLACE_INDEX_MAX_BYTES,
  MARKETPLACE_SIGNATURE_MAX_BYTES,
  CATALOG_KEYS_MAX_BYTES,
  OFFICIAL_INDEX_PATH,
  OFFICIAL_KEYS_PATH,
  MARKETPLACE_SIGNATURE_SUFFIX,
  type MarketplacePackageKind,
} from "@synap-core/types/marketplace-source";
import {
  anonymousGetInit,
  readCapped,
  type SourceFetch,
} from "./marketplace-source-fetch.js";
import {
  checkOfficialListing,
  ed25519PublicKey,
  keyFingerprint,
  verifyKeysStatement,
  verifyOfficialIndex,
} from "./marketplace-source-verify.js";

const logger = createLogger({ module: "official-catalog-signature" });

/**
 * The Control Plane's TEST-ONLY catalog keys. Each is derived from a public
 * label (control-plane-api `src/lib/catalog-signing/__fixtures__/test-keys.ts`),
 * so anyone can recompute its PRIVATE half: they sign the committed contract
 * fixtures and nothing else. Derived here the same way rather than copied, and
 * pinned against the fixtures' own `contract.json` by the tests, so the two
 * repos cannot drift apart silently.
 */
const TEST_ONLY_KEY_LABELS = [
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
    .update(`synap-catalog-signing TEST ONLY — never trusted: ${label}`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const { x } = createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(x ?? "", "base64url").toString("base64");
}

/** The test-only public keys (raw ed25519, base64). Never a trust anchor. */
export const CATALOG_TEST_ONLY_KEYS: ReadonlySet<string> = new Set(
  TEST_ONLY_KEY_LABELS.map(testOnlyPublicKey)
);

/**
 * The root keys a release compiles in, checked when this module loads: none
 * (before the ceremony) or exactly two — the current root and the offline
 * standby — each a raw ed25519 public key (base64, 44 characters), distinct,
 * and never one of the public-label test keys (their private halves are
 * public). Anything else throws: a malformed root fails the tests and the
 * boot, never a release that silently reads as "not signed yet".
 */
export function catalogRootKeys(keys: readonly string[]): readonly string[] {
  if (keys.length !== 0 && keys.length !== 2) {
    throw new Error(
      `SYNAP_CATALOG_ROOT_KEYS holds ${keys.length} keys — a release carries none or exactly two (current, standby).`
    );
  }
  keys.forEach((key, i) => {
    if (ed25519PublicKey(key) === null) {
      throw new Error(
        `SYNAP_CATALOG_ROOT_KEYS[${i}] is not a raw ed25519 public key (base64, 44 characters).`
      );
    }
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error("SYNAP_CATALOG_ROOT_KEYS lists the same key twice.");
  }
  keys.forEach((key, i) => {
    if (CATALOG_TEST_ONLY_KEYS.has(key)) {
      throw new Error(
        `SYNAP_CATALOG_ROOT_KEYS[${i}] is a TEST-ONLY key derived from a public label — anyone can sign with it.`
      );
    }
  });
  return Object.freeze([...keys]);
}

/**
 * Synap's root keys (raw ed25519, base64): the current one and the offline
 * standby, in that order — the public keys the founders' ceremony printed
 * (control-plane-api ops/catalog-signing/README.md). EMPTY until that
 * ceremony: the pod then checks nothing and blocks nothing ("Synap's catalog
 * isn't signed yet"). A root change ships the new key here a release ahead.
 */
export const SYNAP_CATALOG_ROOT_KEYS: readonly string[] = catalogRootKeys([
  // "<current root public key>", "<standby root public key>",
]);

export interface OfficialCatalogTrust {
  /** What the index is checked against: the release's roots, the operator's keys, or nothing yet. */
  anchors: "roots" | "operator" | "none";
  /** roots: the root keys; operator: the keys that sign the index directly. */
  keys: readonly string[];
  /** `SYNAP_CATALOG_ENFORCE_SIGNATURE`: block what does not verify (default: report only). */
  enforce: boolean;
  /** `SYNAP_CATALOG_ALLOW_EXPIRED`: accept signed files past their expiry (air-gapped pods). */
  allowExpired: boolean;
  /** Operator keys that are not raw ed25519 keys (ignored, logged). */
  rejectedKeys: string[];
  /** Operator keys refused in production as public-label test keys (ignored, logged). */
  refusedTestKeys: number;
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** The pod's trust anchors for Synap's catalog, from the release and the environment. */
export function officialCatalogTrust(
  env: NodeJS.ProcessEnv = process.env,
  rootKeys: readonly string[] = SYNAP_CATALOG_ROOT_KEYS
): OfficialCatalogTrust {
  const listed = (env.SYNAP_CATALOG_PUBLIC_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const wellFormed = listed.filter((k) => ed25519PublicKey(k) !== null);
  const rejectedKeys = listed.filter((k) => ed25519PublicKey(k) === null);
  // A test-only key's private half is public: in production it would let
  // anyone sign the catalog this pod installs from. Tests and dev pods may
  // still point at the CP's test-signed fixtures.
  const refuseTestKeys = env.NODE_ENV === "production";
  const operator = refuseTestKeys
    ? wellFormed.filter((k) => !CATALOG_TEST_ONLY_KEYS.has(k))
    : wellFormed;
  const refusedTestKeys = wellFormed.length - operator.length;
  const enforce = envFlag(env.SYNAP_CATALOG_ENFORCE_SIGNATURE);
  const allowExpired = envFlag(env.SYNAP_CATALOG_ALLOW_EXPIRED);
  if (operator.length > 0) {
    return {
      anchors: "operator",
      keys: operator,
      enforce,
      allowExpired,
      rejectedKeys,
      refusedTestKeys,
    };
  }
  return {
    anchors: rootKeys.length > 0 ? "roots" : "none",
    keys: rootKeys,
    enforce,
    allowExpired,
    rejectedKeys,
    refusedTestKeys,
  };
}

let trustLogged = false;

/** Say once per process what Synap's catalog is checked against — an override is loud. */
export function logOfficialCatalogTrust(trust: OfficialCatalogTrust): void {
  if (trustLogged) return;
  trustLogged = true;
  if (trust.rejectedKeys.length > 0) {
    logger.error(
      { rejected: trust.rejectedKeys.length },
      "SYNAP_CATALOG_PUBLIC_KEYS holds values that are not raw ed25519 keys (base64) — they are ignored"
    );
  }
  if (trust.refusedTestKeys > 0) {
    logger.error(
      { refused: trust.refusedTestKeys },
      "SYNAP_CATALOG_PUBLIC_KEYS holds TEST-ONLY keys derived from public labels — refused in production, they are ignored"
    );
  }
  if (trust.anchors === "operator") {
    logger.warn(
      {
        fingerprints: trust.keys.map((k) => keyFingerprint(k).slice(0, 32)),
        enforce: trust.enforce,
      },
      "Synap's catalog is checked against OPERATOR keys (SYNAP_CATALOG_PUBLIC_KEYS), not Synap's root keys — a private mirror or a re-signed catalog"
    );
  } else if (trust.anchors === "none") {
    logger.info(
      "Synap's catalog isn't signed yet (no root keys in this release) — nothing is checked or blocked"
    );
  }
  if (trust.allowExpired) {
    logger.warn(
      "SYNAP_CATALOG_ALLOW_EXPIRED is set — Synap's catalog is accepted with expired signed files"
    );
  }
}

type SignedFile =
  | { ok: true; bytes: Uint8Array; signature: string | null }
  | { ok: false; message: string };

/**
 * One signed file and its detached `.sig`: an anonymous GET, no redirect,
 * byte-capped. The official URL is the pod's configured Control Plane (or a
 * mirror the operator chose), so — unlike an added source — it is not held
 * to public addresses: the signature, not the host, is what is trusted.
 */
async function fetchSignedFile(
  url: string,
  maxBytes: number,
  fetchImpl: SourceFetch
): Promise<SignedFile> {
  const get = async (target: string) => {
    try {
      return await fetchImpl(target, anonymousGetInit());
    } catch {
      return null;
    }
  };
  const res = await get(url);
  if (!res) return { ok: false, message: `The pod couldn't reach ${url}.` };
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      message:
        res.status === 404
          ? `The Control Plane doesn't serve ${url} yet.`
          : `The Control Plane answered ${res.status} for ${url}.`,
    };
  }
  const body = await readCapped(res, maxBytes);
  if (!body.ok) {
    return { ok: false, message: `${url} is too large to read.` };
  }
  const sigRes = await get(`${url}${MARKETPLACE_SIGNATURE_SUFFIX}`);
  if (!sigRes) {
    return {
      ok: false,
      message: `The pod couldn't fetch the signature of ${url}.`,
    };
  }
  if (!sigRes.ok) {
    await sigRes.body?.cancel().catch(() => undefined);
    // No signature is the verifier's verdict (a bad signature), not an outage.
    return { ok: true, bytes: body.bytes, signature: null };
  }
  const sig = await readCapped(sigRes, MARKETPLACE_SIGNATURE_MAX_BYTES);
  return {
    ok: true,
    bytes: body.bytes,
    signature: sig.ok ? new TextDecoder().decode(sig.bytes) : "",
  };
}

export interface OfficialSignatureDeps {
  fetchImpl?: SourceFetch;
  now?: Date;
  trust?: OfficialCatalogTrust;
}

/**
 * Check Synap's signed index against the pod's trust anchors and, when it
 * verifies, make `official_catalog_digests` exactly what it lists. Never
 * throws; records and returns the outcome. Null when no trust anchor is
 * configured (nothing is fetched or recorded).
 */
export async function checkOfficialCatalogSignature(
  baseUrl: string,
  previous: OfficialCatalogSignature | null,
  deps: OfficialSignatureDeps = {}
): Promise<OfficialCatalogSignature | null> {
  const trust = deps.trust ?? officialCatalogTrust();
  logOfficialCatalogTrust(trust);
  if (trust.anchors === "none") return null;
  const now = deps.now ?? new Date();
  const fetchImpl: SourceFetch = deps.fetchImpl ?? fetch;
  const kept: OfficialCatalogSignature = {
    state: "ok",
    lastCheckAt: now.toISOString(),
    lastOkAt: previous?.lastOkAt ?? null,
    validUntil: previous?.validUntil ?? null,
    keysVersion: previous?.keysVersion ?? null,
    keyFingerprint: previous?.keyFingerprint ?? null,
    packageCount: previous?.packageCount ?? 0,
    unverifiedRows: previous?.unverifiedRows ?? null,
    message: null,
  };

  const status = await (async (): Promise<OfficialCatalogSignature> => {
    let catalogKeys = trust.keys;
    let keysVersion: number | null = null;
    if (trust.anchors === "roots") {
      const keysFile = await fetchSignedFile(
        `${baseUrl}${OFFICIAL_KEYS_PATH}`,
        CATALOG_KEYS_MAX_BYTES,
        fetchImpl
      );
      if (!keysFile.ok) {
        return { ...kept, state: "unreachable", message: keysFile.message };
      }
      const keys = verifyKeysStatement({
        statementBytes: keysFile.bytes,
        signature: keysFile.signature,
        rootKeys: trust.keys,
        lastVersion: previous?.keysVersion ?? null,
        allowExpired: trust.allowExpired,
        now,
      });
      if (!keys.ok) {
        return {
          ...kept,
          state: keys.reason === "too_large" ? "invalid" : keys.reason,
          message: keys.message,
        };
      }
      catalogKeys = keys.keys;
      keysVersion = keys.statement.version;
    }

    const indexFile = await fetchSignedFile(
      `${baseUrl}${OFFICIAL_INDEX_PATH}`,
      MARKETPLACE_INDEX_MAX_BYTES,
      fetchImpl
    );
    if (!indexFile.ok) {
      return { ...kept, state: "unreachable", message: indexFile.message };
    }
    const verdict = verifyOfficialIndex({
      indexBytes: indexFile.bytes,
      signature: indexFile.signature,
      trustedKeys: catalogKeys,
      lastAcceptedExpires: previous?.validUntil ?? null,
      allowExpired: trust.allowExpired,
      now,
    });
    if (!verdict.ok) {
      const state =
        verdict.reason === "bad_signature" ||
        verdict.reason === "expired" ||
        verdict.reason === "replayed"
          ? verdict.reason
          : "invalid";
      return { ...kept, state, message: verdict.message };
    }
    try {
      await replaceOfficialCatalogDigests(
        verdict.index.packages.map((pkg) => ({
          kind: pkg.kind,
          slug: pkg.slug,
          version: pkg.version,
          contentHash: pkg.contentHash,
          requiredTier: pkg.requiredTier ?? null,
          syncedAt: now,
        }))
      );
    } catch (err) {
      logger.error({ err }, "Could not store Synap's verified catalog digests");
      return {
        ...kept,
        state: previous?.state === "ok" ? "ok" : "unreachable",
        message:
          "The pod verified Synap's catalog but could not store it — it retries on the next sync.",
      };
    }
    return {
      ...kept,
      state: "ok",
      lastOkAt: now.toISOString(),
      validUntil: verdict.index.expires,
      keysVersion,
      keyFingerprint: verdict.fingerprint,
      packageCount: verdict.index.packages.length,
    };
  })();

  if (status.state === "ok") {
    logger.info(
      { packages: status.packageCount, validUntil: status.validUntil },
      "Synap's catalog signature verified"
    );
  } else {
    logger.warn(
      { state: status.state, message: status.message, enforce: trust.enforce },
      trust.enforce
        ? "Synap's catalog did NOT verify — installs and automatic updates follow the freeze rule"
        : "Synap's catalog did NOT verify — report only, nothing is blocked"
    );
  }
  await recordOfficialCatalogSignature(status);
  return status;
}

/**
 * Report-only pass over the official rows the sync just cached: how many the
 * verified index does not vouch for (unlisted, another version, or — where
 * the row carries its definition — another digest). Logs the first few and
 * records the count on the status. Changes no row. Never throws.
 */
export async function reportUnverifiedOfficialRows(
  cacheKey: string,
  status: OfficialCatalogSignature
): Promise<OfficialCatalogSignature> {
  try {
    const [rows, digests] = await Promise.all([
      db
        .select({
          kind: cpCatalogCache.kind,
          slug: cpCatalogCache.slug,
          version: cpCatalogCache.version,
          definition: cpCatalogCache.definition,
        })
        .from(cpCatalogCache)
        .where(and(eq(cpCatalogCache.source, cacheKey))),
      readOfficialCatalogDigests(),
    ]);
    const listed = new Map(digests.map((d) => [`${d.kind}|${d.slug}`, d]));
    const problems: string[] = [];
    for (const row of rows) {
      const digest = listed.get(`${row.kind}|${row.slug}`) ?? null;
      const problem = row.definition
        ? checkOfficialListing({
            kind: row.kind as MarketplacePackageKind,
            slug: row.slug,
            version: row.version,
            definition: row.definition,
            listed: digest,
          })
        : !digest
          ? `"${row.slug}" is not in Synap's signed catalog.`
          : row.version && row.version !== digest.version
            ? `"${row.slug}" ${row.version} is not the version Synap's signed catalog lists (${digest.version}).`
            : null;
      if (problem) problems.push(`${row.kind}: ${problem}`);
    }
    if (problems.length > 0) {
      logger.warn(
        { unverified: problems.length, first: problems.slice(0, 10) },
        "Official catalog rows the signed index does not vouch for"
      );
    }
    const next = { ...status, unverifiedRows: problems.length };
    await recordOfficialCatalogSignature(next);
    return next;
  } catch (err) {
    logger.warn(
      { err },
      "Could not compare the official catalog with its signed index"
    );
    return status;
  }
}
