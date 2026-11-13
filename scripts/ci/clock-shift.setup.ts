/**
 * Vitest setup file of the nightly shifted-clock run (.github/workflows/
 * clock-shift.yml, scripts/ci/clock-shift.mjs). Env-gated: with
 * CLOCK_SHIFT_DAYS=45, `new Date()` and `Date.now()` answer 45 days later and
 * keep ticking. An explicit date (`new Date("2026-11-01")`, `Date.UTC`,
 * `Date.parse`) is untouched. With the variable unset or 0 it does nothing, so
 * the same wrapper config serves the unshifted comparison pass.
 */
const days = Number(process.env.CLOCK_SHIFT_DAYS ?? 0);

if (days) {
  const RealDate = Date;
  const offsetMs = days * 86_400_000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class ShiftedDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      else super(...(args as [any]));
    }
    static now(): number {
      return RealDate.now() + offsetMs;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = ShiftedDate;
}
