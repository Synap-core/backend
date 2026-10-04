/**
 * Limits for the unauthenticated redeem door.
 *
 * An attacker who knows the owner's email must not be able to shut the door
 * on the owner, so no bucket is keyed on the email ALONE at a low limit:
 *   - per (email, client IP): 5 / 15 min — one guesser against one account;
 *   - per email: 30 / 15 min — a ceiling a distributed guesser still hits;
 *   - a cap on scrypt derivations in flight (not a global count, which any
 *     spray could exhaust for everyone) — the CPU-exhaustion guard.
 * Behind a CDN every visitor can share one edge IP; the per-email ceiling is
 * then what holds. In-process: the numbers hold per pod process (one API).
 */

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Count one attempt; false when the key is over its limit this window. */
  hit(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      this.sweep(t);
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  private sweep(t: number): void {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) {
      if (t - w.start >= this.windowMs) this.windows.delete(k);
    }
  }
}

/** At most `limit` holders at once; `tryAcquire` never waits. */
export class ConcurrencyCap {
  private inFlight = 0;
  constructor(private readonly limit: number) {}
  tryAcquire(): boolean {
    if (this.inFlight >= this.limit) return false;
    this.inFlight += 1;
    return true;
  }
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

export const REDEEM_PER_EMAIL_IP = { limit: 5, windowMs: 15 * 60 * 1000 };
export const REDEEM_PER_EMAIL = { limit: 30, windowMs: 15 * 60 * 1000 };
export const REDEEM_MAX_IN_FLIGHT = 4;
