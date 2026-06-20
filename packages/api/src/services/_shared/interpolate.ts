/**
 * Shared `{{param}}` interpolation for config-template appliers.
 *
 * The ONE implementation of the `{{var}}` substitution scheme used by every
 * template applier (capability-template, loop-template, …) — mirrors the
 * NotificationService templates. Extracted so there is no copy: both
 * `createCapabilityFromDefinition` and `createLoopFromDefinition` import these.
 *
 * The template-local handles (`ref` / `requires` / `playbookRef`) are plain
 * identifiers without `{{}}`, so they survive interpolation unchanged.
 */

/** Replace `{{name}}` tokens in a string with values from `params`. */
export function interpolateString(
  template: string,
  params: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = params[key];
    return value !== undefined && value !== null ? String(value) : "";
  });
}

/** Deep-interpolate every string inside an arbitrary JSON value. */
export function interpolateDeep<T>(
  value: T,
  params: Record<string, unknown>
): T {
  if (typeof value === "string") {
    return interpolateString(value, params) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(v, params)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, params);
    }
    return out as unknown as T;
  }
  return value;
}
