/**
 * Re-export of the canonical pod-admin URL resolver.
 *
 * The implementation moved to `@synap/api`'s `utils/pod-admin-url.ts` when the
 * OAuth authorization server (which lives in `packages/api`, and cannot import
 * upward from `apps/`) needed the same validated base for its consent redirect.
 * This file stays so existing importers here in `apps/api` are untouched — there
 * is still exactly ONE implementation.
 */

export {
  configuredPodAdminBase,
  configuredPodAdminConsentUrl,
  type PodAdminConfigResult,
} from "@synap/api";
