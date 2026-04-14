/**
 * RSS Provider Configuration
 *
 * Provider-specific configuration types and defaults.
 */

import type { RSSProviderConfig } from "./FeedConfig.js";

// ============================================================================
// Direct RSS Provider Configuration
// ============================================================================

/**
 * Default configuration for DirectRSSProvider
 */
export const DirectRSSProviderDefaults: Partial<RSSProviderConfig> = {
  type: "direct",
  timeoutMs: 30000,
  retryAttempts: 3,
  headers: {
    Accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    "Accept-Encoding": "gzip, deflate, br",
  },
};

/**
 * Direct RSS provider capabilities
 */
export const DirectRSSProviderCapabilities = {
  supportsPagination: false,
  supportsFiltering: false,
  supportsAuth: false,
  supportsCustomHeaders: true,
  supportsJson: true,
  supportsRss: true,
  supportsAtom: true,
} as const;

// ============================================================================
// RSSHub Provider Configuration
// ============================================================================

/**
 * RSSHub provider configuration interface
 */
export interface RSSHubProviderConfig extends RSSProviderConfig {
  type: "rsshub";
  /** RSSHub instance base URL */
  url: string;
  /** Access key for restricted routes */
  accessKey?: string;
  /** Enable caching via RSSHub */
  enableCache?: boolean;
  /** Cache TTL in seconds */
  cacheTtlSeconds?: number;
  /** Filter by access level */
  filterAccess?: "all" | "open" | "restricted";
}

/**
 * Default configuration for RSSHubProvider
 */
export const RSSHubProviderDefaults: Partial<RSSHubProviderConfig> = {
  type: "rsshub",
  url: "https://rsshub.app",
  enableCache: true,
  cacheTtlSeconds: 300,
  filterAccess: "all",
};

/**
 * RSSHub provider capabilities
 */
export const RSSHubProviderCapabilities = {
  supportsPagination: true,
  supportsFiltering: true,
  supportsAuth: true,
  supportsCustomHeaders: true,
  supportsJson: true,
  supportsRss: true,
  supportsAtom: true,
} as const;

// ============================================================================
// CP Proxy Provider Configuration
// ============================================================================

/**
 * Control Plane proxy provider configuration interface
 */
export interface CPProxyProviderConfig extends RSSProviderConfig {
  type: "cpproxy";
  /** Control Plane proxy base URL */
  url: string;
  /** API key for CP authentication */
  apiKey: string;
  /** Proxy region for routing */
  region?: string;
  /** Enable rate limit awareness */
  rateLimitAware?: boolean;
  /** Backward compatibility mode */
  legacyMode?: boolean;
}

/**
 * Default configuration for CPProxyProvider
 */
export const CPProxyProviderDefaults: Partial<CPProxyProviderConfig> = {
  type: "cpproxy",
  rateLimitAware: true,
  legacyMode: false,
};

/**
 * CP Proxy provider capabilities
 */
export const CPProxyProviderCapabilities = {
  supportsPagination: true,
  supportsFiltering: false,
  supportsAuth: true,
  supportsCustomHeaders: true,
  supportsJson: true,
  supportsRss: true,
  supportsAtom: true,
} as const;

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
  direct: RSSProviderConfig;
  rsshub: RSSHubProviderConfig;
  cpproxy: CPProxyProviderConfig;
  custom: CustomProviderConfig;
};

/**
 * Get default configuration for a provider type
 */
export function getProviderDefaults(
  type: keyof ProviderConfigMap
): Partial<RSSProviderConfig> {
  switch (type) {
    case "direct":
      return DirectRSSProviderDefaults;
    case "rsshub":
      return RSSHubProviderDefaults;
    case "cpproxy":
      return CPProxyProviderDefaults;
    case "custom":
      return CustomProviderDefaults;
    default:
      return DirectRSSProviderDefaults;
  }
}
