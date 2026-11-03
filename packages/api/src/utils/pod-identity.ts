/**
 * pod-identity — the pod's OWN asymmetric identity (SECURITY-PLAN-R1 §1, D1/D8).
 *
 * The ONE signing door lives in @synap/database (`utils/pod-identity.ts`) so
 * @synap/jobs and the database-level pod→CP readers sign through the same
 * door; this module re-exports it for @synap/api's importers. How a pod→CP
 * request authenticates (pod JWT vs. the transition credentials) is decided
 * by `podCpAuthHeaders` (@synap/database `utils/pod-cp-auth.ts`).
 */

export {
  _resetPodIdentityForTest,
  DEFAULT_POD_IDENTITY_KEY_FILE,
  ecJwkThumbprint,
  getPodJwks,
  getPodKeyId,
  isPodProofNonce,
  podIdentityKeyFile,
  PodIdentityError,
  podIssuerOrigin,
  POD_JWT_MAX_TTL_SECONDS,
  POD_JWT_TYP,
  POD_PROOF_AUDIENCE,
  POD_PROOF_NONCE_MAX_BYTES,
  POD_PROOF_NONCE_MIN_BYTES,
  POD_PROOF_TTL_SECONDS,
  POD_PROOF_TYP,
  signPodJwt,
  signPodProof,
  type PodIdentityErrorCode,
  type PodTokenBinding,
} from "@synap/database";
