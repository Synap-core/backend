/**
 * Context-card projection helpers (pure — no DB).
 *
 * The Discord bridge renders the pinned "what's on this channel" card from the
 * `GET /channels/:channelId/context-card` payload. When the linked entity is a
 * `company`, the card gains five client-oriented fields. These helpers shape
 * the already-fetched raw data into the pinned contract, so they stay unit
 * testable without a database.
 *
 * All helpers are null/empty-safe: a hollow company (no deals, no urls, no
 * status) yields empty arrays / null, never a throw.
 */

/** A deal as projected onto the context card. */
export interface ContextCardDeal {
  id: string;
  title: string | null;
  stage: string | null;
  openUrl: string;
}

/** The minimal shape of a `relations.getConnections` connection we read. */
export interface ConnectionLike {
  entity?: {
    id: string;
    type?: string | null;
    title?: string | null;
    properties?: unknown;
  } | null;
}

function propsOf(
  entity: NonNullable<ConnectionLike["entity"]>
): Record<string, unknown> {
  const p = entity.properties;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/**
 * Filter a connection set to `deal` neighbours and project each onto the card.
 *
 * `stage` tolerates the live 3-way fork in how a deal's stage is stored:
 * `dealStage` (canonical) ?? `stage` ?? `deal-stage`.
 *
 * Connections whose `entity` is null (channels / sessions / soft-deleted rows
 * getConnections already dropped) are skipped.
 */
export function projectDealsFromConnections(
  connections: ConnectionLike[],
  openLink: (id: string) => string
): ContextCardDeal[] {
  const deals: ContextCardDeal[] = [];
  for (const conn of connections) {
    const e = conn.entity;
    if (!e || e.type !== "deal") continue;
    const props = propsOf(e);
    const rawStage = props.dealStage ?? props.stage ?? props["deal-stage"];
    deals.push({
      id: e.id,
      title: e.title ?? null,
      stage: typeof rawStage === "string" && rawStage ? rawStage : null,
      openUrl: openLink(e.id),
    });
  }
  return deals;
}

/**
 * The `stage` of a linked `grant_submission`, if the company has one. Preferred
 * over the client lifecycle status for the card's `status` field.
 */
export function pickGrantSubmissionStage(
  connections: ConnectionLike[]
): string | null {
  for (const conn of connections) {
    const e = conn.entity;
    if (!e || e.type !== "grant_submission") continue;
    const props = propsOf(e);
    const stage = props.stage ?? props.dealStage;
    if (typeof stage === "string" && stage) return stage;
  }
  return null;
}

/**
 * Compose the deduped known-urls list from the company's `website` property and
 * its identity signals. There is NO `knownUrls` property — it is composed here.
 * Dedup is case-insensitive; the first-seen casing wins.
 */
export function composeKnownUrls(
  website: unknown,
  signalValues: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  add(website);
  for (const v of signalValues) add(v);
  return out;
}

/**
 * Resolve the card's `status` field:
 *   1. a linked grant_submission's stage (preferred), else
 *   2. the client lifecycle facet's status (a `client` role facet first, then
 *      any facet carrying a status), else
 *   3. the company's own `status` property, else null.
 */
export function pickClientStatus(params: {
  grantSubmissionStage: string | null;
  facetStatuses: Array<{ slug: string; status: string | null }>;
  companyStatus: unknown;
}): string | null {
  if (params.grantSubmissionStage) return params.grantSubmissionStage;
  const clientFacet = params.facetStatuses.find(
    (f) => f.slug === "client" && f.status
  );
  if (clientFacet?.status) return clientFacet.status;
  const anyFacet = params.facetStatuses.find((f) => f.status);
  if (anyFacet?.status) return anyFacet.status;
  return typeof params.companyStatus === "string" && params.companyStatus
    ? params.companyStatus
    : null;
}
