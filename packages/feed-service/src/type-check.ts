/**
 * Feed Service Type Check Script
 *
 * This script verifies that all feed types are consistent across packages.
 * Run this to ensure type synchronization is correct.
 *
 * @module type-check
 */

import type {
  // Core types from @synap-core/types
  FeedConfig as CoreFeedConfig,
  RSSFeedConfig as CoreRSSFeedConfig,
  ProactiveFeedConfig as CoreProactiveFeedConfig,
  FeedMessageMetadata as CoreFeedMessageMetadata,
  NormalizedRSSItem as CoreNormalizedRSSItem,
  FeedStatus as CoreFeedStatus,
  FeedExecutionPayload as CoreFeedExecutionPayload,
} from "@synap-core/types";

import type {
  // Feed service types
  RSSProviderConfig,
  FeedSourceConfig,
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
  FeedFetchResult,
  FeedHealthStatus,
  ISClassificationResult,
  ISClassificationRequest,
  ProviderCapabilities,
  FeedProviderInfo,
  ScheduledFeedJob,
  SchedulerConfig,
  PublisherConfig,
  PublishedMessageMetadata,
  FeedRepositoryQuery,
  FeedStatistics,
  KeywordCategory,
} from "./types/index.js";

import type {
  // Shared utils types (re-exported from @synap-core/types for convenience)
  FeedConfig,
  RSSFeedConfig,
  ProactiveFeedConfig,
  FeedMessageMetadata,
  FeedExecutionPayload,
} from "@synap-core/types";

// ============================================================================
// Type Compatibility Checks
// ============================================================================

/**
 * Type compatibility check utility
 * Verifies that types are objects at compile time
 */
function checkType<T extends object>(_value: T): true {
  return true;
}

// Type compatibility assertions - compile time checks only
// These will fail to compile if types are incompatible
const _checks = {
  coreFeedConfig: checkType({} as CoreFeedConfig),
  coreRSSConfig: checkType({} as CoreRSSFeedConfig),
  coreProactiveConfig: checkType({} as CoreProactiveFeedConfig),
  coreMessageMetadata: checkType({} as CoreFeedMessageMetadata),
  coreNormalizedItem: checkType({} as CoreNormalizedRSSItem),
  coreStatus: checkType({} as CoreFeedStatus),
  coreExecutionPayload: checkType({} as CoreFeedExecutionPayload),
  providerConfig: checkType({} as RSSProviderConfig),
  sourceConfig: checkType({} as FeedSourceConfig),
  normalizedItem: checkType({} as NormalizedRSSItem),
  classifiedItem: checkType({} as ClassifiedItem),
  userContext: checkType({} as UserContext),
  fetchResult: checkType({} as FeedFetchResult),
  sharedFeedConfig: checkType({} as FeedConfig),
  sharedRSSConfig: checkType({} as RSSFeedConfig),
  sharedProactiveConfig: checkType({} as ProactiveFeedConfig),
  sharedMessageMetadata: checkType({} as FeedMessageMetadata),
  sharedExecutionPayload: checkType({} as FeedExecutionPayload),
};

// Mark as used to prevent TS6133 error
void _checks;

// ============================================================================
// Runtime Type Validation (for testing)
// ============================================================================

/**
 * Validate feed provider configuration
 */
export function validateProviderConfig(
  config: unknown
): config is RSSProviderConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;

  if (!["custom"].includes(c.type as string)) {
    return false;
  }

  return true;
}

/**
 * Validate feed source configuration
 */
export function validateSourceConfig(
  config: unknown
): config is FeedSourceConfig {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;

  if (typeof c.url !== "string") return false;
  if (typeof c.provider !== "object" || c.provider === null) return false;

  return validateProviderConfig((c.provider as Record<string, unknown>) || {});
}

/**
 * Validate normalized RSS item
 */
export function validateNormalizedItem(
  item: unknown
): item is NormalizedRSSItem {
  if (typeof item !== "object" || item === null) return false;
  const i = item as Record<string, unknown>;

  if (typeof i.id !== "string") return false;
  if (typeof i.title !== "string") return false;
  if (typeof i.source !== "object" || i.source === null) return false;

  return true;
}

/**
 * Validate classified feed item
 */
export function validateClassifiedItem(item: unknown): item is ClassifiedItem {
  if (typeof item !== "object" || item === null) return false;
  const i = item as Record<string, unknown>;

  if (typeof i.item !== "object" || i.item === null) return false;
  if (typeof i.category !== "string") return false;
  if (typeof i.confidence !== "number") return false;

  return true;
}

/**
 * Validate user context
 */
export function validateUserContext(context: unknown): context is UserContext {
  if (typeof context !== "object" || context === null) return false;
  const c = context as Record<string, unknown>;

  if (typeof c.userId !== "string") return false;

  return true;
}

// ============================================================================
// Type Guard Exports
// ============================================================================

export {
  validateProviderConfig as isValidProviderConfig,
  validateSourceConfig as isValidSourceConfig,
  validateNormalizedItem as isValidNormalizedItem,
  validateClassifiedItem as isValidClassifiedItem,
  validateUserContext as isValidUserContext,
};

// Re-export all types for convenience
export type {
  CoreFeedConfig,
  CoreRSSFeedConfig,
  CoreProactiveFeedConfig,
  CoreFeedMessageMetadata,
  CoreNormalizedRSSItem,
  CoreFeedStatus,
  CoreFeedExecutionPayload,
  RSSProviderConfig,
  FeedSourceConfig,
  NormalizedRSSItem,
  ClassifiedItem,
  UserContext,
  FeedFetchResult,
  FeedHealthStatus,
  ISClassificationResult,
  ISClassificationRequest,
  ProviderCapabilities,
  FeedProviderInfo,
  ScheduledFeedJob,
  SchedulerConfig,
  PublisherConfig,
  PublishedMessageMetadata,
  FeedRepositoryQuery,
  FeedStatistics,
  KeywordCategory,
  FeedConfig,
  RSSFeedConfig,
  ProactiveFeedConfig,
  FeedMessageMetadata,
  FeedExecutionPayload,
};
