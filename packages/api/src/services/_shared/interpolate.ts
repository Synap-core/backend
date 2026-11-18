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

/** The `{{param}}` grammar — ONE regex, read by the interpolator AND by every
 * reader that must know whether a value still carries an install-time param. */
const PARAM_PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * How a token `params` has NO key for is treated. `"blank"` (default) maps it to
 * "" — the install-time contract for a template's own params. `"keep"` leaves
 * `{{token}}` verbatim: for content with its OWN run-time placeholder namespace,
 * where an unknown name is not an unanswered install param but somebody else's.
 */
export type UnknownParamToken = "blank" | "keep";

/** Replace `{{name}}` tokens in a string with values from `params`. */
export function interpolateString(
  template: string,
  params: Record<string, unknown>,
  unknown: UnknownParamToken = "blank"
): string {
  return template.replace(PARAM_PLACEHOLDER_RE, (token, key: string) => {
    if (unknown === "keep" && !Object.hasOwn(params, key)) return token;
    const value = params[key];
    return value !== undefined && value !== null ? String(value) : "";
  });
}

/**
 * Every `{{param}}` token `interpolateDeep` would substitute inside `value`
 * (deep). `{{vault:<ref>}}` is NOT one — it is resolved from the template's own
 * vault, never from params.
 */
export function paramPlaceholderTokens(value: unknown): string[] {
  return collectMatches(value, PARAM_PLACEHOLDER_RE, 1);
}

/** Every distinct `re` capture `group` in any string inside `value`. */
function collectMatches(value: unknown, re: RegExp, group: number): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(re)) found.add(m[group]!);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}

/** Deep-interpolate every string inside an arbitrary JSON value. */
export function interpolateDeep<T>(
  value: T,
  params: Record<string, unknown>,
  unknown: UnknownParamToken = "blank"
): T {
  if (typeof value === "string") {
    return interpolateString(value, params, unknown) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) =>
      interpolateDeep(v, params, unknown)
    ) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, params, unknown);
    }
    return out as unknown as T;
  }
  return value;
}

/** A string that IS one `{{param}}` and nothing else: the same grammar. */
const WHOLE_VALUE_PARAM_RE = new RegExp(`^${PARAM_PLACEHOLDER_RE.source}$`);

/** Marks a whole-value token whose param is absent: its key is left out. */
const OMIT = Symbol("omit");

/**
 * Deep-interpolate a REQUEST value a verb sends (a declarative verb's `body`,
 * its GraphQL `variables`) from the run's parameters, keeping types:
 * - a string that is EXACTLY one `{{param}}` becomes the param's raw value
 *   (an array, an object, a number, a boolean, `null`), not `String(value)`;
 * - such a string whose param is absent (`undefined`) is left out: its key is
 *   omitted from the parent object, or its element from the parent array. A
 *   required param never gets here absent (the verb's parameter check and
 *   `paramMapping.required` refuse the run first), so absent = optional;
 * - a string mixing text and tokens stays a string (`interpolateString`).
 * Run-time only: install-time template params keep `interpolateDeep`, whose
 * output the drift comparator measures installed rows against.
 */
export function interpolateTyped<T>(
  value: T,
  params: Record<string, unknown>
): T {
  const out = typedValue(value, params);
  return (out === OMIT ? undefined : out) as T;
}

function typedValue(
  value: unknown,
  params: Record<string, unknown>
): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_VALUE_PARAM_RE.exec(value);
    if (!whole) return interpolateString(value, params);
    const v = params[whole[1]!];
    return v === undefined ? OMIT : v;
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => typedValue(v, params))
      .filter((v) => v !== OMIT);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const typed = typedValue(v, params);
      if (typed !== OMIT) out[k] = typed;
    }
    return out;
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
  return collectMatches(value, VAULT_PLACEHOLDER_RE, 1);
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
