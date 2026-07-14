import { z } from "zod";
import {
  API_KEY_SCOPES,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database/schema";

/**
 * Capabilities a Pod owner may grant to a trusted JWT issuer.
 *
 * This is deliberately distinct from the API-key schema. Trusted issuers can
 * perform data operations supported by API keys, but they can also vouch for
 * an external identity and submit narrowly-scoped membership commands. Those
 * identity capabilities are Pod-generic: they do not refer to a particular
 * hosted deployment or orchestrator.
 */
export const TRUSTED_ISSUER_CAPABILITY_VALUES = [
  ...API_KEY_SCOPES,
  // Existing Pod-management capabilities retained for deployed issuers.
  "provision",
  "tier_update",
  "sync",
  // Generic issuer identity and membership capabilities.
  TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE,
  TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
  TRUSTED_ISSUER_CAPABILITIES.MEMBERSHIP_GRANT,
  TRUSTED_ISSUER_CAPABILITIES.SOURCE_CONFIG_WRITE,
  // Compatibility only. The legacy activation handler will move to
  // membership:grant when it is replaced.
  TRUSTED_ISSUER_CAPABILITIES.MEMBER_ACTIVATION,
] as const;

export type TrustedIssuerCapability =
  (typeof TRUSTED_ISSUER_CAPABILITY_VALUES)[number];

export const trustedIssuerCapabilitySchema = z.enum(
  TRUSTED_ISSUER_CAPABILITY_VALUES
);

export const trustedIssuerCapabilitiesSchema = z
  .array(trustedIssuerCapabilitySchema)
  .min(1)
  .transform((capabilities) => Array.from(new Set(capabilities)));
