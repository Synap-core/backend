/**
 * The OFFICIAL renderer bundle: fetched from the pod's Control Plane, then
 * installed (spec c9b1e4d0 §3d; founder, 20 Nov 2026: any pod covered by a
 * Synap plan, whatever its hosting, replacing managed-only of 19 Nov).
 *
 * A pod cannot tell whether a plan covers it, so the gate is the Control
 * Plane's: `GET {CP}/internal/renderer-bundles/:slug[/:version]` answers only
 * a pod-signed token (purpose `renderers`) of a live pod covered by a plan, or
 * a live lab (control-plane-api `routes/internal.ts`, `official-bundle-gate.ts`).
 * Every refusal is FORBIDDEN with a machine reason (`error.data.reasonCode`):
 *
 *   renderer_bundle_no_control_plane  no CONTROL_PLANE_URL (a pod no control plane knows)
 *   renderer_bundle_insecure_control_plane
 *                                     CONTROL_PLANE_URL is not https (only
 *                                     localhost / 127.0.0.1 may be http, in
 *                                     development): no token is sent
 *   renderer_bundle_pod_not_enrolled  no pod-signed credential (the route
 *                                     takes no legacy key)
 *   renderer_bundle_plan_required     the CP refused: no live plan covers the pod
 *   renderer_bundle_pod_not_live      the CP refused: it does not see the pod running
 *
 * AUTHENTICITY. The bundle's BYTES are withheld from Synap's public catalog,
 * but its DIGEST is signed: the signed index lists it under its top-level
 * `rendererBundles` (`{ kind: "renderer-bundle", slug, version, contentHash }`),
 * which the catalog sync stores in `official_catalog_digests` with the other
 * listings. What the CP serves is checked against it exactly as every other
 * official kind is (`assertOfficialDefinition`): `contentHash` is
 * `officialContentHash("renderer-bundle", definition)` (sha256 of the
 * canonical JSON without `_meta`, `contentHash`, `sourcePackage`) and the
 * listed version is the CP row's `package.version`. No trust anchor: admitted
 * as before; report mode: a mismatch is logged; enforce: an unlisted,
 * mismatching or frozen bundle is refused PRECONDITION_FAILED
 * (`MARKET_OFFICIAL_UNVERIFIED`). In every mode the definition must name the
 * slug asked (`_meta.slug`) and the row the version asked. Every source is
 * then re-hashed on install (`installRendererBundle`).
 *
 * VERSION. The CP row's `package.version` (always `h-` + the first 12 hex of
 * the digest) IS the bundle's version: what was asked, what the signed index
 * lists, what `renderer_bundles.version` stores. The body's `_meta.version`
 * is ignored, as the CP ignores it.
 *
 * The CP's honest limit holds here too: this gates DELIVERY, it is not a
 * protection of the code.
 */

import { TRPCError } from "@trpc/server";
import {
  podCpAuthHeaders,
  getDb,
  and,
  eq,
  like,
  notLike,
} from "@synap/database";
import { rendererBundles, widgetDefinitions } from "@synap/database/schema";
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";
import { OFFICIAL_SOURCE_ID } from "@synap-core/types/marketplace-source";
import { RENDERER_BUNDLE_KIND } from "@synap-core/types/renderables";
import type { PackageUpdateReceipt } from "@synap-core/types/package-updates";
import { assertOfficialDefinition } from "../capabilities/official-catalog-trust.js";
import { recordPackageUpdateReceipt } from "../package-updates/receipts.js";
import { clearAfterRendererBundleInstall } from "./renderer-bundle-update-state.js";
import {
  installRendererBundle,
  type InstalledRendererBundle,
} from "./install-renderer-bundle.js";

/** Synap's own renderer bundle (app-bases `renderer-bundles/synap-renderers.yaml`). */
export const SYNAP_RENDERERS_SLUG = "synap-renderers";

export const RENDERER_BUNDLE_NO_CONTROL_PLANE =
  "renderer_bundle_no_control_plane" as const;
export const RENDERER_BUNDLE_INSECURE_CONTROL_PLANE =
  "renderer_bundle_insecure_control_plane" as const;
export const RENDERER_BUNDLE_POD_NOT_ENROLLED =
  "renderer_bundle_pod_not_enrolled" as const;
export const RENDERER_BUNDLE_PLAN_REQUIRED =
  "renderer_bundle_plan_required" as const;
export const RENDERER_BUNDLE_POD_NOT_LIVE =
  "renderer_bundle_pod_not_live" as const;

/** The CP's refusal code for a live pod no Synap plan covers. */
const CP_PLAN_REQUIRED = "OFFICIAL_BUNDLE_PLAN_REQUIRED";
/** The CP's refusal code for a pod it does not see running. */
const CP_POD_NOT_LIVE = "OFFICIAL_BUNDLE_POD_NOT_LIVE";
/** The CP's refusal code for a legacy (non pod-signed) caller. */
const CP_POD_JWT_REQUIRED = "POD_JWT_REQUIRED";

/** A ~5 MB definition: more than the 8 s the catalog reads take. */
const FETCH_TIMEOUT_MS = 30_000;

/** The only hosts a control plane may be reached at over plain http (development). */
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1"]);

function refused(reasonCode: string, message: string): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message, cause: { reasonCode } });
}

function notEnrolled(): TRPCError {
  return refused(
    RENDERER_BUNDLE_POD_NOT_ENROLLED,
    "This pod has no pod-signed credential for its Control Plane, so it cannot fetch the official renderers. Enroll its key: `synap pod-key enroll`. Nothing was installed."
  );
}

function unverified(message: string): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message,
    cause: { code: "MARKET_OFFICIAL_UNVERIFIED" },
  });
}

/** https, or http on localhost / 127.0.0.1 only. */
function isSecureControlPlane(base: string): boolean {
  try {
    const url = new URL(base);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && PLAIN_HTTP_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

/** What the CP served: its row's version and the definition. */
export interface FetchedRendererBundle {
  /** The CP row's `package.version`: the bundle's version. */
  version: string;
  definition: Record<string, unknown>;
}

/**
 * What the CP's metadata read answers (`?meta=1`, lane I1 contract): the row,
 * never its definition, and no delivery is recorded.
 */
export interface RendererBundleMeta {
  slug: string;
  /** The row's `package.version` (`h-` + 12 hex of `contentHash`). */
  version: string;
  /** `officialContentHash("renderer-bundle", definition)`. */
  contentHash: string;
  /** When the row was published (the soak counts from it). */
  publishedAt: Date;
  /** Synap retired this row: a pod holding it converges without waiting. */
  retired: boolean;
}

/**
 * One authenticated GET of `/internal/renderer-bundles/:slug[/:version]`
 * (`?meta=1` for the metadata read), with every refusal mapped to the pod's
 * machine reason. Returns the parsed body of a 2xx.
 */
async function requestOfficialRendererBundle(input: {
  slug: string;
  version?: string | null;
  meta?: boolean;
}): Promise<Record<string, unknown> | null> {
  const base = controlPlaneBaseUrl();
  if (!base) {
    throw refused(
      RENDERER_BUNDLE_NO_CONTROL_PLANE,
      "The official renderers come from the Synap control plane, and this pod has none. Nothing was installed."
    );
  }
  // Before any credential is minted: a pod-signed token never travels over
  // plain http.
  if (!isSecureControlPlane(base)) {
    throw refused(
      RENDERER_BUNDLE_INSECURE_CONTROL_PLANE,
      "This pod reaches its control plane over plain http, so it does not fetch the official renderers from it. Set CONTROL_PLANE_URL to an https:// address. Nothing was installed."
    );
  }
  let auth: Awaited<ReturnType<typeof podCpAuthHeaders>>;
  try {
    auth = await podCpAuthHeaders({
      purpose: "renderers",
      legacy: "internal-key",
      controlPlaneUrl: base,
    });
  } catch (err) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This pod's Control Plane credential cannot be used (${
        err instanceof Error ? err.message : String(err)
      }). Nothing was installed.`,
      cause: { reasonCode: RENDERER_BUNDLE_POD_NOT_ENROLLED },
    });
  }
  // The CP serves the bundle to a pod-signed token only.
  if (!auth || auth.via !== "pod-jwt") throw notEnrolled();

  const path = input.version
    ? `${encodeURIComponent(input.slug)}/${encodeURIComponent(input.version)}`
    : encodeURIComponent(input.slug);
  let res: Response;
  try {
    res = await fetch(
      `${base.replace(/\/$/, "")}/internal/renderer-bundles/${path}${
        input.meta ? "?meta=1" : ""
      }`,
      {
        headers: auth.headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
  } catch (err) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The control plane did not answer (${
        err instanceof Error ? err.message : String(err)
      }). Retry the install later; nothing was installed.`,
    });
  }
  const body = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (res.status === 403 && body?.code === CP_PLAN_REQUIRED) {
    throw refused(
      RENDERER_BUNDLE_PLAN_REQUIRED,
      "The official renderers come with a Synap plan, and no live plan covers this pod. Nothing was installed."
    );
  }
  if (res.status === 403 && body?.code === CP_POD_NOT_LIVE) {
    throw refused(
      RENDERER_BUNDLE_POD_NOT_LIVE,
      "The control plane does not see this pod as running (it is suspended or still being set up), so it sent no renderers. Nothing was installed."
    );
  }
  if (res.status === 403 && body?.code === CP_POD_JWT_REQUIRED) {
    throw notEnrolled();
  }
  if (res.status === 404) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `The control plane has no renderer bundle "${input.slug}"${
        input.version ? ` at ${input.version}` : ""
      }.`,
    });
  }
  if (!res.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The control plane answered ${res.status} for the renderer bundle "${input.slug}". Retry the install later; nothing was installed.`,
    });
  }
  return body;
}

/** Fetch the official bundle's row from this pod's Control Plane. */
export async function fetchOfficialRendererBundle(input: {
  slug: string;
  version?: string | null;
}): Promise<FetchedRendererBundle> {
  const body = await requestOfficialRendererBundle(input);
  const pkg = body?.package as
    { version?: unknown; definition?: unknown } | undefined;
  const version = pkg?.version;
  const definition = pkg?.definition;
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The control plane returned no version or no definition for "${input.slug}". Nothing was installed.`,
    });
  }
  return { version, definition: definition as Record<string, unknown> };
}

/**
 * The CP's metadata read of the bundle: its newest live row, or the row of
 * `version` (retired included). Same gate and refusals as the fetch; the CP
 * sends no definition and records no delivery. A malformed answer throws: an
 * unread version is never a "no update".
 */
export async function fetchOfficialRendererBundleMeta(input: {
  slug: string;
  version?: string | null;
}): Promise<RendererBundleMeta> {
  const body = await requestOfficialRendererBundle({ ...input, meta: true });
  const pkg = (body?.package ?? null) as Record<string, unknown> | null;
  const publishedAt =
    typeof pkg?.publishedAt === "string" ? new Date(pkg.publishedAt) : null;
  if (
    !pkg ||
    pkg.slug !== input.slug ||
    typeof pkg.version !== "string" ||
    pkg.version.length === 0 ||
    typeof pkg.contentHash !== "string" ||
    pkg.contentHash.length === 0 ||
    !publishedAt ||
    Number.isNaN(publishedAt.getTime()) ||
    typeof pkg.retired !== "boolean"
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The control plane's answer about the renderer bundle "${input.slug}" is not one this pod reads (slug, version, contentHash, publishedAt, retired).`,
    });
  }
  return {
    slug: input.slug,
    version: pkg.version,
    contentHash: pkg.contentHash,
    publishedAt,
    retired: pkg.retired,
  };
}

/**
 * Is this the bundle asked for, and does Synap's signed index vouch for it?
 * Throws PRECONDITION_FAILED (`MARKET_OFFICIAL_UNVERIFIED`) when not.
 */
export async function admitOfficialRendererBundle(input: {
  slug: string;
  /** The version asked, if any. */
  version?: string | null;
  fetched: FetchedRendererBundle;
}): Promise<void> {
  const { definition, version } = input.fetched;
  const meta = definition._meta as { slug?: unknown } | undefined;
  const namedSlug = meta && typeof meta === "object" ? meta.slug : undefined;
  if (namedSlug !== input.slug) {
    throw unverified(
      `The renderer bundle served for "${input.slug}" names itself "${String(namedSlug)}". Nothing was installed.`
    );
  }
  if (input.version && version !== input.version) {
    throw unverified(
      `The control plane served "${input.slug}" at "${version}", not "${input.version}". Nothing was installed.`
    );
  }
  await assertOfficialDefinition({
    kind: RENDERER_BUNDLE_KIND,
    slug: input.slug,
    version,
    definition,
  });
}

export const RENDERER_BUNDLE_KIT_REMOVED =
  "RENDERER_BUNDLE_KIT_REMOVED" as const;

/**
 * The kit exports `definition` drops that another frame cell on this pod may
 * still use. Installed cells do not record their kit imports, so a dropped
 * name counts as used when it appears in the source of any active frame cell
 * that is not this bundle's own (`cell:<slug>:*`) and imports `@synap/kit`:
 * an over-count (a word in a comment) holds an update, it never breaks a cell.
 */
export async function kitExportsStillUsed(
  slug: string,
  definition: Record<string, unknown>
): Promise<string[]> {
  const db = await getDb();
  const [row] = await db
    .select({ kitExports: rendererBundles.kitExports })
    .from(rendererBundles)
    .where(eq(rendererBundles.slug, slug))
    .limit(1);
  const next = new Set(
    Array.isArray(definition.kitExports)
      ? definition.kitExports.filter((n): n is string => typeof n === "string")
      : []
  );
  const dropped = (row?.kitExports ?? []).filter((n) => !next.has(n));
  if (dropped.length === 0) return [];
  const others = await db
    .select({ source: widgetDefinitions.rendererSource })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.rendererType, "frame"),
        eq(widgetDefinitions.isActive, true),
        notLike(widgetDefinitions.typeKey, `cell:${slug}:%`),
        like(widgetDefinitions.rendererSource, "%@synap/kit%")
      )
    );
  return dropped.filter((name) => {
    const word = new RegExp(
      `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );
    return others.some((c) => word.test(c.source ?? ""));
  });
}

/**
 * Fetch, admit and install the official bundle: the `market.install` door and
 * the update doors (a person's apply, the after-sync pass). An install that
 * replaced another version is an UPDATE: it writes one receipt
 * (`package.updated`, its one change the bundle's `version`), which Undo takes
 * back within 30 days from the version kept on the pod. Any landed install
 * clears the bundle's hold, refusal and wait.
 *
 * `holdKitRemoval` (the pass, applying on its own): a version that drops kit
 * exports another frame cell may use is refused `RENDERER_BUNDLE_KIT_REMOVED`
 * before anything is written, so it waits for a person.
 */
export async function installOfficialRendererBundle(input: {
  slug: string;
  version?: string | null;
  userId: string;
  /** Who applied it, on the receipt: a person (default) or the after-sync pass. */
  appliedBy?: "person" | "automatic";
  holdKitRemoval?: boolean;
}): Promise<
  InstalledRendererBundle & { receipt: PackageUpdateReceipt | null }
> {
  const fetched = await fetchOfficialRendererBundle(input);
  await admitOfficialRendererBundle({ ...input, fetched });
  if (input.holdKitRemoval) {
    const used = await kitExportsStillUsed(input.slug, fetched.definition);
    if (used.length > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `This version drops ${used.join(", ")} from the kit, which another cell on this pod may use. It waits for a person to apply it. Nothing was installed.`,
        cause: { reasonCode: RENDERER_BUNDLE_KIT_REMOVED, names: used },
      });
    }
  }
  const installed = await installRendererBundle(fetched.definition, {
    userId: input.userId,
    source: OFFICIAL_SOURCE_ID,
    version: fetched.version,
  });
  await clearAfterRendererBundleInstall(installed.slug);
  const from = installed.previousVersion;
  const receipt =
    from && from !== installed.version
      ? await recordPackageUpdateReceipt({
          slug: installed.slug,
          kind: RENDERER_BUNDLE_KIND,
          name: rendererBundleName(installed.slug),
          fromVersion: from,
          toVersion: installed.version,
          userId: input.userId,
          source: input.appliedBy ?? "person",
          changes: [
            {
              rowKind: RENDERER_BUNDLE_KIND,
              rowId: installed.slug,
              field: "version",
              before: from,
              after: installed.version,
            },
          ],
        })
      : null;
  return { ...installed, receipt };
}

/** The name a person reads for a bundle (the definition carries none). */
export function rendererBundleName(slug: string): string {
  return slug === SYNAP_RENDERERS_SLUG ? "Synap renderers" : slug;
}
