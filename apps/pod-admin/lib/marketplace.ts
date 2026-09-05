/**
 * Marketplace — shared types + the Control Plane catalog client.
 *
 * ONE catalog: the Control Plane's `synap_packages` (`GET {CP}/api/packages`).
 * Pod Admin does not keep a second catalog. It never surfaces a "verified"
 * badge (a typosquat has become `isVerified` by registering a domain) and it
 * never displays or ranks by install count — that counter is bumped by an
 * unauthenticated, non-idempotent endpoint, so it is an attacker-writable
 * integer, not social proof.
 *
 * The CP is reached from THIS Next process (see `app/api/marketplace/*`), not
 * from the browser: the CP origin then stays server-owned (no CORS grant, no
 * build-time NEXT_PUBLIC bake) exactly like `lib/kratos.ts` reaches Kratos.
 */

/**
 * The six package kinds. Mirrors the Control Plane's `PACKAGE_TYPES` SSOT
 * (`synap-control-plane-api/src/db/schema/packages.ts`), which pod-admin
 * cannot import across repos — `packages/api/src/__tripwires__/
 * cp-pod-package-schema-parity.test.ts` is the backend-side guard for the
 * definition schema; this list is only the browse filter. `profile-pack` is a
 * RETIRED type: readable from old rows, never a filter.
 */
export const PACKAGE_KINDS = [
  "workspace",
  "capability",
  "skill",
  "workflow",
  "view",
  "cell",
] as const;

export type PackageKind = (typeof PACKAGE_KINDS)[number];

export function isPackageKind(value: string): value is PackageKind {
  return (PACKAGE_KINDS as readonly string[]).includes(value);
}

/** A catalog row as returned by `GET {CP}/api/packages` (no `definition`). */
export interface CatalogPackage {
  id: string;
  slug: string;
  version: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  domain: string | null;
  tags: string[] | null;
  category: string;
  createdAt: string;
  /**
   * Publishing provenance. `source` says HOW the row got into the catalog
   * (e.g. "file-seed"); the two ids are opaque UUIDs and the catalog carries no
   * publisher NAME, so a surface must not imply one it cannot resolve.
   *
   * `installCount` is deliberately NOT modelled. `POST /api/packages/:slug/install`
   * bumps it with no session and no idempotency key, so it is an
   * attacker-writable integer; rendering it beside a package name reads as
   * endorsement the system cannot back — the same reason there is no "Verified"
   * badge. Leaving it off the type is what stops it drifting back onto a card.
   */
  source?: string | null;
  authorId?: string | null;
  vendorId?: string | null;
}

export interface CatalogPage {
  packages: CatalogPackage[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET {CP}/api/packages/:slug` — the catalog row plus its full definition. */
export interface PackageDetail extends CatalogPackage {
  definition: PackageDefinition;
}

/**
 * The subset of a package definition Pod Admin reads to describe an install.
 * Everything is optional: a definition is authored data, and a `capability`
 * package carries almost none of these keys.
 */
export interface PackageDefinition {
  workspaceName?: string;
  description?: string;
  profiles?: unknown[];
  views?: unknown[];
  capabilities?: unknown[];
  automations?: unknown[];
  playbooks?: unknown[];
  cells?: unknown[];
  suggestedEntities?: unknown[];
  entityLinks?: unknown[];
  relationDefs?: unknown[];
  commands?: unknown[];
  dependencies?: { slug: string; kind?: string; relation?: string }[];
  workspaceCapabilities?: string[];
  [key: string]: unknown;
}

/**
 * Control Plane origin. Server-only — `CONTROL_PLANE_URL` is the same variable
 * name the pod backend reads (`deploy/docker-compose.yml`), so an operator
 * configures one value for both.
 */
export function controlPlaneUrl(): string {
  return (process.env.CONTROL_PLANE_URL ?? "https://api.synap.live").replace(
    /\/$/,
    ""
  );
}
