/**
 * Fixed-window attempt counter for the unauthenticated redeem door.
 *
 * Why not the IP limiter every other door uses: behind Cloudflare every
 * visitor can arrive from one edge IP (docker-compose.yml), so a per-IP bucket
 * is a shared bucket. The redeem door is keyed per EMAIL (a guess against one
 * account) and GLOBALLY (a spray across accounts) instead.
 *
 * In-process, like every limiter in this app: the numbers hold per pod
 * process. The pod runs one API process.
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

/** Per email: 5 attempts / 15 min. Global: 100 attempts / 15 min. */
export const REDEEM_PER_EMAIL = { limit: 5, windowMs: 15 * 60 * 1000 };
export const REDEEM_GLOBAL = { limit: 100, windowMs: 15 * 60 * 1000 };
