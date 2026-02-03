/**
 * Session Cache Utility (Backend)
 *
 * Optional caching for session validation results.
 * Reduces Kratos API calls when multiple requests come in quick succession.
 *
 * Note: This is optional - middleware already caches, so this is for
 * high-traffic scenarios where backend gets many requests with same session.
 */

interface CacheEntry {
  session: any;
  expires: number;
}

class SessionCache {
  private cache = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL = 5000; // 5 seconds

  /**
   * Get cached session
   * @param cookie - Session cookie value
   * @returns Cached session or undefined
   */
  get(cookie: string): any | undefined {
    if (!cookie) return undefined;

    const entry = this.cache.get(cookie);
    if (!entry) return undefined;

    // Check if expired
    if (Date.now() > entry.expires) {
      this.cache.delete(cookie);
      return undefined;
    }

    return entry.session;
  }

  /**
   * Set cached session
   * @param cookie - Session cookie value
   * @param session - Session data (or null if invalid)
   * @param ttl - Time to live in milliseconds (default: 5s)
   */
  set(
    cookie: string,
    session: any | null,
    ttl: number = this.DEFAULT_TTL
  ): void {
    if (!cookie) return;

    // Only cache valid sessions (null means invalid, don't cache)
    if (session === null) {
      // Don't cache invalid sessions - let each request check fresh
      return;
    }

    this.cache.set(cookie, {
      session,
      expires: Date.now() + ttl,
    });
  }

  /**
   * Clear cache entry
   * @param cookie - Session cookie value
   */
  delete(cookie: string): void {
    if (cookie) {
      this.cache.delete(cookie);
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [cookie, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(cookie);
      }
    }
  }
}

// Singleton instance
export const sessionCache = new SessionCache();

// Cleanup expired entries every 10 seconds
if (typeof globalThis !== "undefined") {
  setInterval(() => {
    sessionCache.cleanup();
  }, 10000);
}
