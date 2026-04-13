/**
 * Retry Utilities
 *
 * Provides retry logic with exponential backoff for resilient operations.
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "retry-utils" });

export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: Array<string | RegExp>;
  onRetry?: (error: Error, attempt: number) => void;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly attempt?: number
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export class NonRetryableError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable based on the configured patterns.
 */
function isRetryableError(
  error: Error,
  retryableErrors?: Array<string | RegExp>
): boolean {
  if (!retryableErrors || retryableErrors.length === 0) {
    // Default: retry all errors except explicit non-retryable ones
    return true;
  }

  const errorMessage = error.message.toLowerCase();

  for (const pattern of retryableErrors) {
    if (typeof pattern === "string") {
      if (errorMessage.includes(pattern.toLowerCase())) {
        return true;
      }
    } else if (pattern instanceof RegExp) {
      if (pattern.test(error.message)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Execute an operation with retry logic and exponential backoff.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialBackoffMs = 1000,
    maxBackoffMs = 30000,
    backoffMultiplier = 2,
    retryableErrors,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is the last attempt
      if (attempt >= maxRetries) {
        throw new RetryableError(
          `Operation failed after ${maxRetries + 1} attempts: ${lastError.message}`,
          lastError,
          attempt
        );
      }

      // Check if error is retryable
      if (!isRetryableError(lastError, retryableErrors)) {
        throw new NonRetryableError(
          `Non-retryable error: ${lastError.message}`,
          lastError
        );
      }

      // Calculate backoff with exponential increase and jitter
      const baseBackoff =
        initialBackoffMs * Math.pow(backoffMultiplier, attempt);
      const jitter = Math.random() * 0.3 * baseBackoff; // Add up to 30% jitter
      const backoffMs = Math.min(baseBackoff + jitter, maxBackoffMs);

      logger.warn(
        {
          error: lastError.message,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          backoffMs: Math.round(backoffMs),
        },
        "Operation failed, retrying"
      );

      if (onRetry) {
        try {
          onRetry(lastError, attempt + 1);
        } catch (callbackError) {
          logger.warn({ callbackError }, "Retry callback failed");
        }
      }

      await sleep(backoffMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Unknown retry failure");
}

/**
 * Execute an operation with retry, returning a result object instead of throwing.
 */
export async function withRetryResult<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<{ success: boolean; data?: T; error?: Error; attempts: number }> {
  let attempts = 0;

  try {
    const data = await withRetry(async () => {
      attempts++;
      return await operation();
    }, options);
    return { success: true, data, attempts };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      attempts,
    };
  }
}

/**
 * Default retry options for database operations.
 */
export const DB_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialBackoffMs: 100,
  maxBackoffMs: 5000,
  backoffMultiplier: 2,
  retryableErrors: [
    "connection",
    "timeout",
    "deadlock",
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ECONNREFUSED/i,
  ],
};

/**
 * Default retry options for external API calls.
 */
export const API_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: [
    "timeout",
    "rate limit",
    "too many requests",
    "service unavailable",
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /5\d{2}/, // 5xx errors
    /429/, // Too Many Requests
    /503/, // Service Unavailable
    /502/, // Bad Gateway
    /504/, // Gateway Timeout
  ],
};

/**
 * Default retry options for feed operations.
 */
export const FEED_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 2,
  initialBackoffMs: 500,
  maxBackoffMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: [
    "timeout",
    "network",
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
  ],
};
