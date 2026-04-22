/**
 * RSS Provider Configuration
 *
 * Provider-specific configuration types and defaults.
 */

import type { RSSProviderConfig } from "./FeedConfig.js";

// ============================================================================
// Custom Provider Configuration
// ============================================================================

/**
 * Custom provider configuration interface
 */
export interface CustomProviderConfig extends RSSProviderConfig {
  type: "custom";
  /** Custom fetch function identifier */
  fetcherId: string;
  /** Custom parser identifier */
  parserId?: string;
  /** Arbitrary configuration for the custom provider */
  customConfig: Record<string, unknown>;
}

/**
 * Default configuration for CustomProvider
 */
export const CustomProviderDefaults: Partial<CustomProviderConfig> = {
  type: "custom",
};

/**
 * Custom provider capabilities (all false by default, determined by implementation)
 */
export const CustomProviderCapabilities = {
  supportsPagination: false,
  supportsFiltering: false,
  supportsAuth: false,
  supportsCustomHeaders: true,
  supportsJson: false,
  supportsRss: false,
  supportsAtom: false,
} as const;

// ============================================================================
// Provider Registry
// ============================================================================

/**
 * Provider configuration type mapping
 */
export type ProviderConfigMap = {
  custom: CustomProviderConfig;
};

/**
 * Get default configuration for a provider type
 */
export function getProviderDefaults(
  type: keyof ProviderConfigMap
): Partial<RSSProviderConfig> {
  switch (type) {
    case "custom":
      return CustomProviderDefaults;
    default:
      return {};
  }
}
