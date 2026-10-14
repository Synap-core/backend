/**
 * pod-cp-auth — the ONE place a pod decides HOW it authenticates to its
 * Control Plane (SECURITY-PLAN-R1 §1, wave R1-b). Every pod→CP sender asks
 * `podCpAuthHeaders({ purpose, legacy })` for its headers, per request; none
 * reads a credential itself.
 *
 *   enrolled pod   a fresh pod-signed JWT (`signPodJwt`, ≤ 5 min, single use —
 *                  so it is minted for EVERY request, never cached)
 *   otherwise      today's credential, unchanged: the fleet-shared
 *                  `SYNAP_POD_INTERNAL_KEY` (X-Internal-Key) or the CP-pushed
 *                  relay JWT (`readCpRelayCredential`)
 *
 * "Enrolled" = the installer's enrollment record exists
 * (`<deploy>/state/pod-identity-enrollment.json`, written by `synap pod-key
 * enroll` or by a registration that sent the key). The key FILE alone is not
 * enough: `synap install` creates it on every pod, but the CP only knows it
 * once it was registered or enrolled — a key the CP has never seen would turn
 * every call into a 401. The CP, for its part, refuses the legacy credential
 * from a pod that HAS an enrolled key (POD_LEGACY_AUTH_REFUSED), so the two
 * sides switch together.
 *
 * Purposes mirror the CP's `POD_CALLER_PURPOSES`
 * (synap-control-plane-api src/lib/pod-caller-auth.ts).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  getPodKeyId,
  podIdentityKeyFile,
  PodIdentityError,
  signPodJwt,
} from "./pod-identity.js";
import {
  readCpRelayCredential,
  type CpRelayCredentialDeps,
} from "./cp-relay-credential.js";

export type PodCpPurpose =
  "invites" | "projects" | "capabilities" | "relay" | "broker";

/** The credential a call site used before R1-b (its transition fallback). */
export type PodCpLegacyCredential = "internal-key" | "relay-key";

export type PodCpAuth =
  | {
      via: "pod-jwt";
      headers: { Authorization: string };
      /** The raw token, for a client that builds its own header. */
      bearer: string;
    }
  | { via: "internal-key"; headers: { "X-Internal-Key": string } }
  | {
      via: "relay-key";
      headers: { Authorization: string };
      bearer: string;
      /** The relay JWT's own `exp` (unverified), for a legible expiry fault. */
      expiresAt: Date | null;
    };

export interface PodEnrollment {
  podId: string;
  /** The kid the CP enrolled (absent on records written before it was kept). */
  kid: string | null;
  /** The CP issuer origin = the audience of every pod token (if recorded). */
  issuer: string | null;
}

export function podEnrollmentFile(): string {
  return (
    process.env.SYNAP_POD_IDENTITY_ENROLLMENT_FILE?.trim() ||
    path.join(
      path.dirname(path.dirname(podIdentityKeyFile())),
      "pod-identity-enrollment.json"
    )
  );
}

/**
 * The installer's enrollment record, or null when the pod never enrolled
 * (absent file = a fact). An unreadable record THROWS — it is neither
 * "enrolled" nor "not enrolled".
 */
export function readPodEnrollment(): PodEnrollment | null {
  let raw: string;
  try {
    raw = readFileSync(podEnrollmentFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PodIdentityError(
      "POD_ENROLLMENT_UNREADABLE",
      "The pod's enrollment record exists but cannot be read."
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (typeof parsed.podId !== "string" || !parsed.podId) {
    throw new PodIdentityError(
      "POD_ENROLLMENT_UNREADABLE",
      "The pod's enrollment record is not valid JSON with a podId."
    );
  }
  return {
    podId: parsed.podId,
    kid: typeof parsed.kid === "string" && parsed.kid ? parsed.kid : null,
    issuer:
      typeof parsed.issuer === "string" && parsed.issuer ? parsed.issuer : null,
  };
}

function controlPlaneOrigin(controlPlaneUrl: string | undefined): string {
  const raw = controlPlaneUrl ?? process.env.CONTROL_PLANE_URL ?? "";
  try {
    return new URL(raw).origin;
  } catch {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      "CONTROL_PLANE_URL is not set, so this pod has no Control Plane to sign for."
    );
  }
}

/**
 * The headers that authenticate THIS request to the Control Plane, or null
 * when the pod holds no credential for it (normal for a self-hosted pod).
 * Throws when a credential exists but cannot be used (key file missing on an
 * enrolled pod, key replaced since enrollment, relay vault unreadable) — a
 * failed read is never reported as "no credential".
 */
export interface PodCpAuthOptions<L extends PodCpLegacyCredential> {
  purpose: PodCpPurpose;
  legacy: L;
  /** The CP transport URL the caller sends to (default CONTROL_PLANE_URL). */
  controlPlaneUrl?: string;
  /** Handles for the relay-key reader (see `CpRelayCredentialDeps`). */
  relay?: CpRelayCredentialDeps;
}

/** What a call site whose legacy credential is `L` can receive. */
export type PodCpAuthFor<L extends PodCpLegacyCredential> = Extract<
  PodCpAuth,
  { via: "pod-jwt" | L }
>;

export async function podCpAuthHeaders<L extends PodCpLegacyCredential>(
  options: PodCpAuthOptions<L>
): Promise<PodCpAuthFor<L> | null>;
export async function podCpAuthHeaders(
  options: PodCpAuthOptions<PodCpLegacyCredential>
): Promise<PodCpAuth | null> {
  const enrollment = readPodEnrollment();
  if (enrollment) {
    if (enrollment.kid && enrollment.kid !== getPodKeyId()) {
      throw new PodIdentityError(
        "POD_KEY_NOT_ENROLLED",
        "This pod's identity key is not the key its Control Plane enrolled. Re-enroll it: `synap pod-key enroll`."
      );
    }
    const audience =
      enrollment.issuer ?? controlPlaneOrigin(options.controlPlaneUrl);
    const token = signPodJwt({ audience, purpose: options.purpose }, {});
    return {
      via: "pod-jwt",
      headers: { Authorization: `Bearer ${token}` },
      bearer: token,
    };
  }

  if (options.legacy === "internal-key") {
    const key = process.env.SYNAP_POD_INTERNAL_KEY;
    return key
      ? { via: "internal-key", headers: { "X-Internal-Key": key } }
      : null;
  }
  const credential = await readCpRelayCredential(options.relay);
  return credential
    ? {
        via: "relay-key",
        headers: { Authorization: `Bearer ${credential.key}` },
        bearer: credential.key,
        expiresAt: credential.expiresAt,
      }
    : null;
}
