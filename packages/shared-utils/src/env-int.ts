/**
 * THE integer-from-environment parser: one rule for every tunable pod knob.
 *
 *   - unset, empty, or not a plain decimal integer (`"4.5"`, `"0x10"`, `"-1"`,
 *     `"abc"`) → `default`;
 *   - below `min` → `default` (a value too small to be safe is a typo, not a
 *     request — never silently raised to the floor);
 *   - above `max` → `max` (a ceiling the code can actually honour).
 */
export function envInt(
  env: Record<string, string | undefined>,
  name: string,
  bounds: { default: number; min: number; max: number }
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return bounds.default;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < bounds.min) return bounds.default;
  return Math.min(n, bounds.max);
}
