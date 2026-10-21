/**
 * Synap's catalog signature, on the read side — the ONE place every reader of
 * an official definition asks "may this install or converge?" (install by
 * key, capability templates, workspace templates, cells, the tier check, the
 * converge after a sync). The rule itself is `officialCatalogStanding`
 * (@synap-core/types/marketplace-source) over what the catalog sync recorded
 * (`official-catalog-signature.ts` in @synap/jobs); the digest check is
 * `checkOfficialListing` against the last verified index.
 *
 * Three modes, never a fourth:
 *   unsigned — no trust anchor yet: every definition is admitted, as before;
 *   report   — every check runs and a refusal is LOGGED, nothing is refused;
 *   enforce  — a definition the verified index does not vouch for is
 *              refused, and a failed or lapsed index pauses installs and
 *              automatic updates (the cached catalog stays listed).
 */

import { TRPCError } from "@trpc/server";
import {
  readMarketplaceSources,
  readOfficialCatalogDigest,
  readOfficialCatalogDigestsForSlug,
  type MarketplaceSourcesSnapshot,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  PRIVATE_CAPABILITY_TRUST,
  officialCatalogStanding,
  type MarketplacePackageKind,
  type OfficialCatalogStanding,
} from "@synap-core/types/marketplace-source";
import { officialCatalogTrust } from "@synap/jobs/workers/official-catalog-signature.js";
import { checkOfficialListing } from "@synap/jobs/workers/marketplace-source-verify.js";

const logger = createLogger({ module: "official-catalog-trust" });

/** Where Synap's catalog signature stands, from one settings snapshot. */
export function officialStanding(
  snapshot: Pick<MarketplaceSourcesSnapshot, "officialSignature"> | null,
  now: Date = new Date()
): OfficialCatalogStanding {
  const trust = officialCatalogTrust();
  return officialCatalogStanding({
    anchors: trust.anchors !== "none",
    enforce: trust.enforce,
    allowExpired: trust.allowExpired,
    status: snapshot?.officialSignature ?? null,
    now,
  });
}

/** Where Synap's catalog signature stands now. A settings read that fails reads as "never checked". */
export async function officialCatalogStandingNow(
  now: Date = new Date()
): Promise<OfficialCatalogStanding> {
  const snapshot =
    officialCatalogTrust().anchors === "none"
      ? null
      : await readMarketplaceSources().catch(() => null);
  return officialStanding(snapshot, now);
}

export type OfficialAdmission =
  | { admitted: true; standing: OfficialCatalogStanding }
  | { admitted: false; reason: string; standing: OfficialCatalogStanding };

/**
 * Does Synap's verified index vouch for this definition, and may it be used
 * now? `version` is the one the caller is about to apply, when it knows it.
 * Report mode answers `admitted: true` and logs what enforcement would refuse.
 */
export async function admitOfficialDefinition(input: {
  kind: MarketplacePackageKind;
  slug: string;
  version?: string | null;
  definition: Record<string, unknown>;
}): Promise<OfficialAdmission> {
  const standing = await officialCatalogStandingNow();
  if (standing.mode === "unsigned") return { admitted: true, standing };
  const reason =
    standing.blocked ??
    checkOfficialListing({
      kind: input.kind,
      slug: input.slug,
      version: input.version ?? null,
      definition: input.definition,
      listed: await readOfficialCatalogDigest(input.kind, input.slug).catch(
        () => null
      ),
    }) ??
    (standing.verified
      ? null
      : (standing.notice ?? "Synap's catalog isn't verified."));
  if (!reason) return { admitted: true, standing };
  if (standing.mode === "report") {
    logger.warn(
      { kind: input.kind, slug: input.slug, reason },
      "Official definition not vouched for by Synap's signed index (report only — used anyway)"
    );
    return { admitted: true, standing };
  }
  logger.warn(
    { kind: input.kind, slug: input.slug, reason },
    "Official definition refused: not vouched for by Synap's signed index"
  );
  return { admitted: false, reason, standing };
}

/**
 * `admitOfficialDefinition`, as a refusal: throws PRECONDITION_FAILED naming
 * the reason when enforcement refuses. For the install doors.
 */
export async function assertOfficialDefinition(input: {
  kind: MarketplacePackageKind;
  slug: string;
  version?: string | null;
  definition: Record<string, unknown>;
}): Promise<void> {
  const verdict = await admitOfficialDefinition(input);
  if (verdict.admitted) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${verdict.reason} Nothing was installed.`,
    cause: { code: "MARKET_OFFICIAL_UNVERIFIED" },
  });
}

/**
 * A capability the Control Plane's AUTHENTICATED owner door served as private
 * (`isPublic: false`) — the only definitions exempt from Synap's public
 * index, because they cannot be in it; their trust is that connection. The
 * exemption never covers a public catalog row: when the signed index lists
 * the key (or the listing cannot be read), the definition is checked like
 * any other official one. Call it ONLY for the owner door's private answer.
 */
export async function admitPrivateCapability(input: {
  key: string;
  definition: Record<string, unknown>;
}): Promise<void> {
  const listed = await readOfficialCatalogDigest("capability", input.key).then(
    (row) => row !== null,
    () => true
  );
  if (listed) {
    await assertOfficialDefinition({
      kind: "capability",
      slug: input.key,
      definition: input.definition,
    });
    return;
  }
  logger.info(
    { kind: "capability", slug: input.key, trust: PRIVATE_CAPABILITY_TRUST },
    `Capability "${input.key}": ${PRIVATE_CAPABILITY_TRUST} (not in Synap's public signed index)`
  );
}

/**
 * The required tier Synap's verified index lists for a slug (the highest of
 * its kinds). Null while unsigned or when the index does not list the slug;
 * `enforce` says whether the caller must take it over its own read.
 */
export async function signedRequiredTier(
  slug: string,
  rank: (tier: string) => number
): Promise<{ tier: string | null; enforce: boolean } | null> {
  const standing = await officialCatalogStandingNow();
  if (standing.mode === "unsigned" || !standing.verified) return null;
  const rows = await readOfficialCatalogDigestsForSlug(slug).catch(() => []);
  if (rows.length === 0) return null;
  const tier = rows
    .map((r) => r.requiredTier)
    .reduce<string | null>(
      (top, t) => (t && (!top || rank(t) > rank(top)) ? t : top),
      null
    );
  return { tier, enforce: standing.mode === "enforce" };
}
