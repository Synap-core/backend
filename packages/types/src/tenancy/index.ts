/** @folder Synap Cloud tenant naming: the zones pods live under, the hosts a pod name gets, and the names no cookie or first-party base may cover. */

/**
 * The ONE statement of how Synap Cloud names a pod. A pod named `{name}` is
 * `{name}.pod.synap.live`; its console is `admin.{name}.pod.synap.live`; anything
 * else its tenant runs is `{label}.{name}.pod.synap.live`. `pod.synap.live` is a
 * tenant zone: each name directly under it belongs to a different tenant, and the
 * zone is submitted to the Public Suffix List so browsers treat each pod as its
 * own site. The pod's Kratos cookie is scoped to `{name}.pod.synap.live`.
 *
 * Pods named before that are still accepted, until each one is moved, and never
 * created anew:
 *   - nested: `pod.{name}.synap.live` with its console `pod-admin.{name}.synap.live`;
 *   - flat: `{name}.synap.live` with its console `{name}-admin.synap.live` (pod and
 *     console share only the zone, so nothing can be shared between them).
 *
 * Copies that cannot import this module are pinned to it by a parity test:
 *   - the installer `synap` (`synap_tenant_zones`, `pod_admin_domain_for_domain`,
 *     `shared_cookie_domain`, `synap_first_party_web_origins`):
 *     `installer-parity.test.ts` here runs the installer's own functions;
 *   - desktop main (browser `electron/main/connection/registrable-domain.ts`):
 *     its `registrable-domain.parity.test.ts` imports this module;
 *   - the Control Plane (`podHostsForName`, `FIRST_PARTY_WEB_SUBDOMAINS`): its
 *     `desktop-console-host.contract.test.ts`.
 *
 * Pure and dependency-free: safe in Node, browsers, React Native and Next.js.
 */

/** The Control Plane's pod-name grammar (`POD_NAME_RE`, control-plane-api `src/lib/pod-registration-tokens.ts`). */
export const POD_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Zones whose every direct child is one tenant's pod: `{name}.{zone}`. Production
 * first; the staging Control Plane names its pods under the second.
 */
export const TENANT_ZONES = [
  "pod.synap.live",
  "pod.staging.synap.live",
] as const;

/**
 * Zones pods were named under before. Synap's own hosts (the Control Plane, the
 * apps) live there as well, so these stay refused as a cookie domain or a
 * first-party base after every pod has moved.
 */
export const LEGACY_TENANT_ZONES = [
  "synap.live",
  "staging.synap.live",
] as const;

/** The label of a pod's console under its pod host. */
export const CONSOLE_LABEL = "admin";

/** Labels under a pod host the pod's tenant may not use for anything else. */
export const RESERVED_POD_LABELS: readonly string[] = [CONSOLE_LABEL];

/**
 * The Synap-hosted web apps, by subdomain of the zone a pod's Control Plane runs
 * under (`synap.live`, or `staging.synap.live`). A pod's Kratos admits them (CORS)
 * and returns to them (return_to) for "Continue with Synap Cloud", beside the
 * zone's apex; never every host of the zone. The Control Plane keeps the same
 * list (`FIRST_PARTY_WEB_SUBDOMAINS`, control-plane-api `src/lib/trusted-origins.ts`).
 */
export const FIRST_PARTY_WEB_SUBDOMAINS = [
  "www",
  "app",
  "dashboard",
  "connect",
  "relay",
  "doc",
  "docs",
  "crm",
  "hub",
  "studio",
  "canvas",
  "devplane",
  "arch",
  "the-arch-grants",
  "mini-app",
] as const;

export type TenantZone = (typeof TENANT_ZONES)[number];
export type LegacyTenantZone = (typeof LEGACY_TENANT_ZONES)[number];

/** A pod's two hosts. */
export interface PodHosts {
  podHost: string;
  consoleHost: string;
}

/** What a Synap Cloud pod host is, and the console it pairs with. */
export type TenantPodHost =
  | (PodHosts & { scheme: "current"; name: string; zone: TenantZone })
  | (PodHosts & {
      scheme: "legacy-nested";
      name: string;
      zone: LegacyTenantZone;
    })
  | (PodHosts & {
      scheme: "legacy-flat";
      name: string;
      zone: LegacyTenantZone;
    });

function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isPodName(name: string): boolean {
  return POD_NAME_RE.test(name) && !RESERVED_POD_LABELS.includes(name);
}

/** Is `host` itself a zone where different tenants live (current or legacy)? */
export function isTenantZone(host: string): boolean {
  const h = normalize(host);
  return (
    (TENANT_ZONES as readonly string[]).includes(h) ||
    (LEGACY_TENANT_ZONES as readonly string[]).includes(h)
  );
}

/**
 * A base no pod may scope a cookie or a first-party CORS base to: a bare TLD
 * (no dot) or a tenant zone, either of which admits hosts the pod does not own.
 */
export function isRefusedSiteBase(base: string): boolean {
  const b = normalize(base).replace(/^\.+/, "");
  return !b.includes(".") || isTenantZone(b);
}

/** The most specific tenant zone (current or legacy) `host` is under, or null. */
export function tenantZoneOf(
  host: string
):
  | { zone: TenantZone; legacy: false }
  | { zone: LegacyTenantZone; legacy: true }
  | null {
  const h = normalize(host);
  for (const zone of TENANT_ZONES) {
    if (h.endsWith(`.${zone}`)) return { zone, legacy: false };
  }
  // Longest legacy zone first: `x.staging.synap.live` is under staging.
  const legacy = [...LEGACY_TENANT_ZONES].sort((a, b) => b.length - a.length);
  for (const zone of legacy) {
    if (h.endsWith(`.${zone}`)) return { zone, legacy: true };
  }
  return null;
}

/** The hosts a pod named `name` is given: `{name}.{zone}` and `admin.{name}.{zone}`. */
export function podHostsForName(
  name: string,
  zone: TenantZone = TENANT_ZONES[0]
): PodHosts {
  if (!isPodName(name)) throw new RangeError(`Not a pod name: ${name}`);
  if (!(TENANT_ZONES as readonly string[]).includes(zone)) {
    throw new RangeError(`Not a tenant zone: ${zone}`);
  }
  const podHost = `${name}.${zone}`;
  return { podHost, consoleHost: `${CONSOLE_LABEL}.${podHost}` };
}

/**
 * The nested pair a pod named `name` had under a legacy zone, the names it moves
 * from: `pod.{name}.{zone}` and `pod-admin.{name}.{zone}`.
 */
export function legacyPairFor(
  name: string,
  zone: LegacyTenantZone = LEGACY_TENANT_ZONES[0]
): PodHosts {
  if (!isPodName(name)) throw new RangeError(`Not a pod name: ${name}`);
  if (!(LEGACY_TENANT_ZONES as readonly string[]).includes(zone)) {
    throw new RangeError(`Not a legacy tenant zone: ${zone}`);
  }
  return {
    podHost: `pod.${name}.${zone}`,
    consoleHost: `pod-admin.${name}.${zone}`,
  };
}

/**
 * The tenant zone a legacy zone's pods move to: `synap.live` → `pod.synap.live`,
 * `staging.synap.live` → `pod.staging.synap.live`.
 */
export function currentZoneFor(legacy: LegacyTenantZone): TenantZone {
  return `pod.${legacy}` as TenantZone;
}

/**
 * Read a Synap Cloud pod host: which naming it follows, its name and its console.
 * Null for anything that is not a pod host the Control Plane issues: a zone
 * itself, a console, a tenant's other site, Synap's own hosts under a current
 * zone, any host outside the zones.
 */
export function parseTenantPodHost(host: string): TenantPodHost | null {
  const h = normalize(host);
  const at = isTenantZone(h) ? null : tenantZoneOf(h);
  if (!at) return null;
  const labels = h.slice(0, -(at.zone.length + 1)).split(".");
  if (!at.legacy) {
    if (labels.length !== 1 || !isPodName(labels[0])) return null;
    return {
      scheme: "current",
      name: labels[0],
      zone: at.zone,
      ...podHostsForName(labels[0], at.zone),
    };
  }
  if (labels.length === 2 && labels[0] === "pod" && isPodName(labels[1])) {
    return {
      scheme: "legacy-nested",
      name: labels[1],
      zone: at.zone,
      ...legacyPairFor(labels[1], at.zone),
    };
  }
  if (labels.length === 1 && isPodName(labels[0])) {
    return {
      scheme: "legacy-flat",
      name: labels[0],
      zone: at.zone,
      podHost: h,
      consoleHost: `${labels[0]}-admin.${at.zone}`,
    };
  }
  return null;
}

/**
 * The console host for a pod host. A Synap Cloud pod: the console its naming
 * pairs with (`admin.{name}.pod.synap.live`, legacy `pod-admin.{name}.synap.live`
 * or `{name}-admin.synap.live`); any other host under a tenant zone has none
 * (null). A self-hosted pod follows the installer's convention: `pod.{root}` →
 * `pod-admin.{root}`, `{sub}.{root}` → `{sub}-admin.{root}`, a single label `x`
 * → `pod-admin.x`. A configured console (`POD_ADMIN_URL`) always wins over this.
 */
export function consoleHostForPod(podHost: string): string | null {
  const h = normalize(podHost);
  if (!h) return null;
  const tenant = parseTenantPodHost(h);
  if (tenant) return tenant.consoleHost;
  if (isTenantZone(h) || tenantZoneOf(h)) return null;
  if (h.startsWith("pod.")) return `pod-admin.${h.slice("pod.".length)}`;
  const dot = h.indexOf(".");
  if (dot > 0) return `${h.slice(0, dot)}-admin.${h.slice(dot + 1)}`;
  return `pod-admin.${h}`;
}

/** The longest DNS suffix two hosts share ("" when none). */
function commonParent(a: string, b: string): string {
  const al = normalize(a).split(".");
  const bl = normalize(b).split(".");
  const out: string[] = [];
  while (al.length && bl.length && al[al.length - 1] === bl[bl.length - 1]) {
    out.unshift(al.pop() as string);
    bl.pop();
  }
  return out.join(".");
}

/**
 * The domain a pod's session cookie is scoped to so the pod and its console
 * share it: their common parent, unless that is a TLD or a tenant zone (then
 * null: the cookie stays on the pod's own host). `{name}.pod.synap.live` for a
 * pod under the current naming, `{name}.synap.live` for a nested legacy pod,
 * null for a flat one. The installer also refuses any Public Suffix List entry.
 */
export function sharedCookieDomain(
  podHost: string,
  consoleHost: string
): string | null {
  const common = commonParent(podHost, consoleHost);
  return common && !isRefusedSiteBase(common) ? common : null;
}

/**
 * The base under which a pod's own surfaces are first-party to it, derived from
 * its public host. A Synap Cloud pod: `{name}.pod.synap.live` (its console and
 * the tenant's other sites), legacy nested `{name}.synap.live`, legacy flat none.
 * A self-hosted pod: its host without the `pod.` / `pod-admin.` service label
 * (`pod.acme.example` → `acme.example`); any other host none. Never a TLD or a
 * tenant zone.
 */
export function firstPartyBaseForPodHost(host: string): string | null {
  const h = normalize(host);
  const tenant = parseTenantPodHost(h);
  if (tenant) {
    if (tenant.scheme === "current") return tenant.podHost;
    if (tenant.scheme === "legacy-nested")
      return `${tenant.name}.${tenant.zone}`;
    return null;
  }
  if (tenantZoneOf(h)) return null;
  const labels = h.split(".");
  if (labels[0] !== "pod" && labels[0] !== "pod-admin") return null;
  const base = labels.slice(1).join(".");
  return isRefusedSiteBase(base) ? null : base;
}

/**
 * The Synap apps a pod's sign-in admits: the apex of the zone its Control Plane
 * runs under and every {@link FIRST_PARTY_WEB_SUBDOMAINS} app there, as https
 * origins. A pod under staging (`*.staging.synap.live`) gets staging's apps;
 * every other pod, Synap Cloud or self-hosted, gets production's.
 */
export function firstPartyWebOrigins(podHost: string): string[] {
  const h = normalize(podHost);
  const zone =
    h === "staging.synap.live" || h.endsWith(".staging.synap.live")
      ? "staging.synap.live"
      : "synap.live";
  return [
    `https://${zone}`,
    ...FIRST_PARTY_WEB_SUBDOMAINS.map((sub) => `https://${sub}.${zone}`),
  ];
}
