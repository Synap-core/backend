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

/**
 * `{{vault:<ref>}}` — a template's reference to ONE OF ITS OWN `vault[]`
 * entries, by that entry's template-local `ref`.
 *
 * A code skill can only redeem a secret with `secrets.get('vault://<id>')`, and
 * the id does not exist until the applier creates the secret, so a template
 * cannot write it. This placeholder is how it names it. The `:` keeps it out of
 * `interpolateString`'s `\w+` grammar, so param interpolation leaves it intact
 * for the applier to resolve once the secret exists.
 */
const VAULT_PLACEHOLDER_RE = /\{\{vault:([A-Za-z0-9_.-]+)\}\}/g;

/** Every template-local vault ref a value names through `{{vault:<ref>}}`. */
export function vaultPlaceholderRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(VAULT_PLACEHOLDER_RE)) refs.add(m[1]!);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return [...refs];
}

/**
 * Replace every `{{vault:<ref>}}` inside `value` with the `vault://<id>` the
 * applier created for that ref. `vaultRefs` holds ONLY the template's own
 * entries, so a placeholder can never reach another template's secret. An
 * unknown ref throws: a placeholder left in place is a credential that is
 * silently never there.
 */
export function interpolateVaultRefs<T>(
  value: T,
  vaultRefs: ReadonlyMap<string, string>
): T {
  if (typeof value === "string") {
    return value.replace(VAULT_PLACEHOLDER_RE, (_, ref: string) => {
      const resolved = vaultRefs.get(ref);
      if (!resolved) {
        throw new Error(
          `{{vault:${ref}}} matches no vault[] entry in this template.`
        );
      }
      return resolved;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateVaultRefs(v, vaultRefs)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateVaultRefs(v, vaultRefs);
    }
    return out as unknown as T;
  }
  return value;
}
