/**
 * Circuit Breaker Pattern
 *
 * Prevents cascade failures by temporarily disabling operations
 * that are consistently failing.
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "circuit-breaker" });

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxCalls?: number;
  successThreshold?: number;
  name?: string;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
}

/**
 * Circuit breaker implementation for resilient operations.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing fast, requests immediately rejected
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private halfOpenCalls = 0;
  private totalCalls = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly successThreshold: number;
  private readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 3;
    this.successThreshold = options.successThreshold ?? 2;
    this.name = options.name ?? "circuit-breaker";
  }

  /**
   * Get current circuit state and statistics.
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Check if circuit is currently open (failing fast).
   */
  isOpen(): boolean {
    if (this.state === "open") {
      // Check if we should transition to half-open
      if (Date.now() - (this.lastFailureTime || 0) > this.resetTimeoutMs) {
        this.transitionToHalfOpen();
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute a function through the circuit breaker.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check if circuit is open
    if (this.isOpen()) {
      const error = new Error(
        `Circuit breaker '${this.name}' is OPEN - too many failures, requests rejected`
      );
      logger.warn(
        {
          circuitName: this.name,
          lastFailureTime: this.lastFailureTime,
          resetTimeoutMs: this.resetTimeoutMs,
        },
        "Circuit breaker open, rejecting request"
      );
      throw error;
    }

    // In half-open state, limit concurrent test calls
    if (this.state === "half-open") {
      if (this.halfOpenCalls >= this.halfOpenMaxCalls) {
        throw new Error(
          `Circuit breaker '${this.name}' is HALF-OPEN - max test calls reached`
        );
      }
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      if (this.state === "half-open") {
        this.halfOpenCalls = Math.max(0, this.halfOpenCalls - 1);
      }
    }
  }

  /**
   * Execute with fallback value on failure.
   */
  async executeWithFallback<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.execute(fn);
    } catch (error) {
      logger.warn(
        {
          circuitName: this.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Circuit breaker execution failed, using fallback"
      );
      return fallback;
    }
  }

  /**
   * Record a successful execution.
   */
  private onSuccess(): void {
    this.successes++;
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();

    if (this.state === "half-open") {
      if (this.successes >= this.successThreshold) {
        this.transitionToClosed();
      }
    } else {
      // In closed state, reset failures on success
      this.failures = 0;
    }
  }

  /**
   * Record a failed execution.
   */
  private onFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Any failure in half-open goes back to open
      this.transitionToOpen();
    } else if (this.failures >= this.failureThreshold) {
      this.transitionToOpen();
    }
  }

  /**
   * Transition to closed state (normal operation).
   */
  private transitionToClosed(): void {
    logger.info(
      {
        circuitName: this.name,
        previousState: this.state,
        totalFailures: this.totalFailures,
      },
      "Circuit breaker closed - service recovered"
    );
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
  }

  /**
   * Transition to open state (failing fast).
   */
  private transitionToOpen(): void {
    if (this.state !== "open") {
      logger.error(
        {
          circuitName: this.name,
          previousState: this.state,
          failures: this.failures,
          resetTimeoutMs: this.resetTimeoutMs,
        },
        "Circuit breaker opened - too many failures"
      );
    }
    this.state = "open";
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
  }

  /**
   * Transition to half-open state (testing recovery).
   */
  private transitionToHalfOpen(): void {
    logger.info(
      {
        circuitName: this.name,
        previousState: this.state,
      },
      "Circuit breaker half-open - testing service recovery"
    );
    this.state = "half-open";
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
  }

  /**
   * Manually reset the circuit breaker to closed state.
   */
  reset(): void {
    logger.info(
      {
        circuitName: this.name,
        previousState: this.state,
      },
      "Circuit breaker manually reset"
    );
    this.transitionToClosed();
  }

  /**
   * Manually open the circuit breaker.
   */
  forceOpen(): void {
    logger.warn(
      {
        circuitName: this.name,
        previousState: this.state,
      },
      "Circuit breaker manually opened"
    );
    this.transitionToOpen();
  }
}

/**
 * Circuit breaker registry for managing multiple breakers.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /**
   * Get or create a circuit breaker.
   */
  get(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker({ name, ...options }));
    }
    return this.breakers.get(name)!;
  }

  /**
   * Get all circuit breaker statistics.
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Reset all circuit breakers.
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Clear all circuit breakers from registry.
   */
  clear(): void {
    this.breakers.clear();
  }
}

// Global registry instance
export const circuitBreakerRegistry = new CircuitBreakerRegistry();
