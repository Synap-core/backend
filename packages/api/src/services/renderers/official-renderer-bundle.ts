/**
 * The OFFICIAL renderer bundle: fetched from the pod's Control Plane, then
 * installed (spec c9b1e4d0 §3d; founder, 19 Nov 2026: available only to pods
 * managed through the control plane, never to a self-hosted pod).
 *
 * A pod cannot tell whether it is managed, so the gate is the Control
 * Plane's: `GET {CP}/internal/renderer-bundles/:slug[/:version]` answers only
 * a pod-signed token (purpose `renderers`) of a pod it manages and that is
 * live (control-plane-api `routes/internal.ts`, `official-bundle-gate.ts`).
 * Every refusal is FORBIDDEN with a machine reason (`error.data.reasonCode`):
 *
 *   renderer_bundle_no_control_plane  no CONTROL_PLANE_URL (a self-hosted pod)
 *   renderer_bundle_pod_not_enrolled  no pod-signed credential (the route
 *                                     takes no legacy key)
 *   renderer_bundle_managed_only      the CP refused: not a managed, live pod
 *
 * TRUST. The bundle is withheld from Synap's signed public index (the CP
 * serves `definition: null` for the kind and leaves it out of the index), so
 * `assertOfficialDefinition` would refuse it under enforcement. Its trust is
 * the authenticated pod→CP connection, as for a private capability
 * (`admitPrivateCapability`): the definition must name what was asked
 * (`_meta.slug`, and the version when one was asked), and Synap's catalog
 * freeze still applies (`standing.blocked`). Every source is then re-hashed
 * on install (`installRendererBundle`).
 *
 * The CP's honest limit holds here too: this gates DELIVERY, it is not a
 * protection of the code.
 */

import { TRPCError } from "@trpc/server";
import { podCpAuthHeaders } from "@synap/database";
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";
import { OFFICIAL_SOURCE_ID } from "@synap-core/types/marketplace-source";
import { officialCatalogStandingNow } from "../capabilities/official-catalog-trust.js";
import {
  installRendererBundle,
  type InstalledRendererBundle,
} from "./install-renderer-bundle.js";

export const RENDERER_BUNDLE_NO_CONTROL_PLANE =
  "renderer_bundle_no_control_plane" as const;
export const RENDERER_BUNDLE_POD_NOT_ENROLLED =
  "renderer_bundle_pod_not_enrolled" as const;
export const RENDERER_BUNDLE_MANAGED_ONLY =
  "renderer_bundle_managed_only" as const;

/** The CP's refusal code for a pod it does not manage. */
const CP_MANAGED_ONLY = "OFFICIAL_BUNDLE_MANAGED_ONLY";
/** The CP's refusal code for a legacy (non pod-signed) caller. */
const CP_POD_JWT_REQUIRED = "POD_JWT_REQUIRED";

/** A ~5 MB definition: more than the 8 s the catalog reads take. */
const FETCH_TIMEOUT_MS = 30_000;

function refused(reasonCode: string, message: string): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message, cause: { reasonCode } });
}

function notEnrolled(): TRPCError {
  return refused(
    RENDERER_BUNDLE_POD_NOT_ENROLLED,
    "This pod has no pod-signed credential for its Control Plane, so it cannot fetch the official renderers. Enroll its key: `synap pod-key enroll`. Nothing was installed."
  );
}

/** Fetch the official bundle's definition from this pod's Control Plane. */
export async function fetchOfficialRendererBundle(input: {
  slug: string;
  version?: string | null;
}): Promise<Record<string, unknown>> {
  const base = controlPlaneBaseUrl();
  if (!base) {
    throw refused(
      RENDERER_BUNDLE_NO_CONTROL_PLANE,
      "The official renderers come from the Synap control plane, and this pod has none. Nothing was installed."
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
      `${base.replace(/\/$/, "")}/internal/renderer-bundles/${path}`,
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
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
    package?: { definition?: unknown };
  } | null;
  if (res.status === 403 && body?.code === CP_MANAGED_ONLY) {
    throw refused(
      RENDERER_BUNDLE_MANAGED_ONLY,
      "The official renderers are available only on pods managed through the Synap control plane. Nothing was installed."
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
  const definition = body?.package?.definition;
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The control plane returned no definition for "${input.slug}". Nothing was installed.`,
    });
  }
  return definition as Record<string, unknown>;
}

/**
 * Is this definition the one asked for, and may Synap's catalog install now?
 * Throws PRECONDITION_FAILED (`MARKET_OFFICIAL_UNVERIFIED`) when not.
 */
export async function admitOfficialRendererBundle(input: {
  slug: string;
  version?: string | null;
  definition: Record<string, unknown>;
}): Promise<void> {
  const meta = input.definition._meta as
    { slug?: unknown; version?: unknown } | undefined;
  const named = meta && typeof meta === "object" ? meta : {};
  const wrong =
    named.slug !== input.slug
      ? `names itself "${String(named.slug)}"`
      : input.version && named.version !== input.version
        ? `is version "${String(named.version)}", not "${input.version}"`
        : null;
  if (wrong) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The renderer bundle served for "${input.slug}" ${wrong}. Nothing was installed.`,
      cause: { code: "MARKET_OFFICIAL_UNVERIFIED" },
    });
  }
  const standing = await officialCatalogStandingNow();
  if (standing.blocked) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${standing.blocked} Nothing was installed.`,
      cause: { code: "MARKET_OFFICIAL_UNVERIFIED" },
    });
  }
}

/** Fetch, admit and install the official bundle (the `market.install` door). */
export async function installOfficialRendererBundle(input: {
  slug: string;
  version?: string | null;
  userId: string;
}): Promise<InstalledRendererBundle> {
  const definition = await fetchOfficialRendererBundle(input);
  await admitOfficialRendererBundle({ ...input, definition });
  return installRendererBundle(definition, {
    userId: input.userId,
    source: OFFICIAL_SOURCE_ID,
  });
}
