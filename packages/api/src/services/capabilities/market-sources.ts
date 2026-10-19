/**
 * Market sources — the install side of "sources you choose, with trust"
 * (Pod Console D11). Answers, for the install door and the console:
 *   - which source a request names (`resolveMarketSource`): a bare request is
 *     the OFFICIAL source, never "whichever source has that slug";
 *   - whether that source may serve an install right now (`marketSourceGate`,
 *     fed to `decideMarketInstall` from @synap-core/types/marketplace-source);
 *   - a third-party definition, fetched anonymously from the signed listing
 *     and checked against its digest (`resolveListedDefinition`).
 *
 * Resolving the official source needs no settings read: it is the configured
 * Control Plane, exactly as before. Its gate reads the pod admin's switch and
 * where Synap's catalog signature stands (`officialStanding`).
 */

import { TRPCError } from "@trpc/server";
import {
  readMarketplaceSources,
  type MarketplaceSourceStatus,
  type MarketplaceSourcesSnapshot,
  type OfficialCatalogSignature,
} from "@synap/database";
import type { CatalogListing } from "@synap/database/schema";
import {
  describeCatalogSources,
  officialCatalogUrl,
  type CatalogSource,
} from "@synap/jobs/workers/cp-catalog-sync.js";
import { fetchDefinitionBytes } from "@synap/jobs/workers/marketplace-source-fetch.js";
import { verifyDefinitionBytes } from "@synap/jobs/workers/marketplace-source-verify.js";
import {
  OFFICIAL_SOURCE_ID,
  MARKETPLACE_DEFINITION_MAX_BYTES,
  qualifiedPackageId,
  sourceBlockReason,
  type MarketSourceGate,
  type OfficialCatalogStanding,
} from "@synap-core/types/marketplace-source";
import { appliedPackageVersion } from "../applied-package-version.js";
import { officialStanding } from "./official-catalog-trust.js";

/** The official source's descriptor, from the environment alone. */
export function officialMarketSource(): CatalogSource {
  return describeCatalogSources(null)[0]!;
}

/**
 * The source a request names: omitted, `synap` or the official URL → the
 * official source (no settings read); an added source's id → that source.
 * Anything else is refused — an install never guesses where it comes from.
 */
export async function resolveMarketSource(
  name?: string | null
): Promise<CatalogSource> {
  if (!name || name === OFFICIAL_SOURCE_ID || name === officialCatalogUrl()) {
    return officialMarketSource();
  }
  const all = describeCatalogSources(await readMarketplaceSources());
  const found = all.find((s) => s.id === name || s.cacheKey === name);
  if (!found) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `"${name}" is not a catalog source on this pod.`,
    });
  }
  return found;
}

/**
 * May this source serve installs right now? Official: only the pod admin's
 * switch blocks it (`SYNAP_CATALOG_SOURCE=off` keeps the cached catalog
 * installable, as before). An added source: its switch, a pending key
 * change, or a lapsed index.
 */
export async function marketSourceGate(
  source: CatalogSource,
  now: Date = new Date()
): Promise<MarketSourceGate> {
  if (source.official) {
    const snapshot = await readMarketplaceSources().catch(() => null);
    return officialGate(snapshot, now);
  }
  const { status } = await readMarketplaceSources();
  const own = status[source.id];
  return {
    trust: source.trust,
    agentsMayPropose: source.agentsMayPropose,
    blocked: sourceBlockReason({
      enabled: source.enabled,
      state: own?.state ?? "pending",
      validUntil: own?.validUntil ?? null,
      now,
    }),
  };
}

/**
 * The official source's gate: the pod admin's switch, then Synap's catalog
 * signature (`officialCatalogStanding` — only an enforced freeze blocks).
 */
function officialGate(
  snapshot: MarketplaceSourcesSnapshot | null,
  now: Date
): MarketSourceGate {
  if (snapshot?.official?.enabled === false) {
    return {
      trust: "official",
      blocked: "Synap's catalog is turned off on this pod.",
    };
  }
  return {
    trust: "official",
    blocked: officialStanding(snapshot, now).blocked,
  };
}

export interface MarketSourceView {
  source: CatalogSource;
  gate: MarketSourceGate;
  status: MarketplaceSourceStatus | null;
  /** Official only: where Synap's catalog signature stands, and its last check. */
  signature?: {
    standing: OfficialCatalogStanding;
    status: OfficialCatalogSignature | null;
  };
}

/**
 * Every catalog source with its gate and last sync status — ONE settings
 * read. A settings read that fails still answers the official source (its
 * switch then reads as on), so the catalog never disappears with a hiccup.
 */
export async function listMarketSources(
  now: Date = new Date()
): Promise<MarketSourceView[]> {
  const snapshot = await readMarketplaceSources().catch(() => null);
  return describeCatalogSources(snapshot).map((source) => {
    const status = snapshot?.status[source.id] ?? null;
    const gate: MarketSourceGate = source.official
      ? officialGate(snapshot, now)
      : {
          trust: source.trust,
          agentsMayPropose: source.agentsMayPropose,
          blocked: sourceBlockReason({
            enabled: source.enabled,
            state: status?.state ?? "pending",
            validUntil: status?.validUntil ?? null,
            now,
          }),
        };
    return source.official
      ? {
          source,
          gate,
          status,
          signature: {
            standing: officialStanding(snapshot, now),
            status: snapshot?.officialSignature ?? null,
          },
        }
      : { source, gate, status };
  });
}

/**
 * The provenance id an install stamps: the bare slug for the official
 * source (unchanged), `<sourceId>/<slug>` for any other — so `acme/crm` can
 * never converge onto, or be reconciled as, Synap's `crm`.
 */
export function provenanceSlug(source: CatalogSource, slug: string): string {
  return source.official ? slug : qualifiedPackageId(source.id, slug);
}

/**
 * Fetch and verify a third-party package's definition: anonymous GET of the
 * signed `definitionUrl`, sha256 over the exact bytes, then — when the listed
 * version is a content version (`h-…`) — the same content rule the pod stamps
 * applied packages with. Any mismatch refuses; nothing is half-read.
 */
export async function resolveListedDefinition(entry: {
  slug: string;
  version: string | null;
  listing: CatalogListing | null;
}): Promise<Record<string, unknown>> {
  if (!entry.listing?.definitionUrl || !entry.listing.sha256) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `"${entry.slug}" has no verified definition address — wait for the next sync.`,
    });
  }
  const fetched = await fetchDefinitionBytes(
    entry.listing.definitionUrl,
    MARKETPLACE_DEFINITION_MAX_BYTES
  );
  if (!fetched.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `${fetched.message} Nothing was installed.`,
    });
  }
  const verdict = verifyDefinitionBytes(fetched.bytes, entry.listing.sha256);
  if (!verdict.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${verdict.message}`,
      cause: { code: "MARKET_DEFINITION_REJECTED", reason: verdict.reason },
    });
  }
  if (
    entry.version?.startsWith("h-") &&
    appliedPackageVersion(verdict.definition) !== entry.version
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The definition of "${entry.slug}" does not match its listed version ${entry.version}, so nothing was installed.`,
      cause: { code: "MARKET_DEFINITION_REJECTED", reason: "version_mismatch" },
    });
  }
  return verdict.definition;
}
