/**
 * The DTCG reader every brand-kit token mapper shares (`DTCG_TO_OD` in
 * `open-design.ts`, `DTCG_TO_SYNAP` in `synap-css.ts`), and the ONE rule that
 * picks a brand's approved token set among Brand Library rows.
 *
 * Internal to `@synap-core/types/brand-kit`: `index.ts` does not re-export it.
 */

/** True when the node is a DTCG document: a `$value` leaf somewhere below. */
export function isDtcg(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return false;
  const o = node as Record<string, unknown>;
  return (
    "$value" in o ||
    Object.entries(o).some(([k, v]) => !k.startsWith("$") && isDtcg(v))
  );
}

/**
 * Every `$value` leaf by its dotted path. With `lights`, a leaf's
 * `$extensions["com.synap.modes"].light` (Synap's light-mode value; `$value` is
 * the dark one) is collected under the same path.
 */
export function dtcgLeaves(
  node: unknown,
  path: string[],
  out: Map<string, unknown>,
  lights?: Map<string, unknown>
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const o = node as Record<string, unknown>;
  if ("$value" in o) {
    out.set(path.join("."), o["$value"]);
    const ext = o["$extensions"] as Record<string, unknown> | undefined;
    const modes = ext?.["com.synap.modes"] as
      | Record<string, unknown>
      | undefined;
    if (lights && modes && "light" in modes)
      lights.set(path.join("."), modes["light"]);
    return;
  }
  for (const [k, v] of Object.entries(o))
    if (!k.startsWith("$")) dtcgLeaves(v, [...path, k], out, lights);
}

/** A DTCG value as CSS text; `{a.b}` references are followed (depth-limited). */
export function dtcgText(
  value: unknown,
  leaves: Map<string, unknown>,
  depth = 0
): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => dtcgText(v, leaves, depth + 1))
      .filter((v): v is string => !!v);
    // A font stack: quote a family name that has a space.
    return parts
      .map((p) => (/\s/.test(p) && !/^["']/.test(p) ? `"${p}"` : p))
      .join(", ");
  }
  if (typeof value !== "string") return undefined;
  const ref = /^\{([^}]+)\}$/.exec(value.trim());
  return ref ? dtcgText(leaves.get(ref[1]!), leaves, depth + 1) : value.trim();
}

/** A CSS value that cannot close a declaration or block, or open markup. */
export function cssValue(value: string): string {
  return value
    .replace(/[;{}<>\\\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The brand's approved `brand-token-set` rows, best first: `token-status`
 * `active` (missing = active), mode `base` (or none) before any other mode,
 * then the lowest title. Each mapper takes the first row it can read.
 */
export function activeTokenSets(
  entities: ReadonlyArray<{
    profileSlug: string;
    title: string;
    properties: Record<string, unknown>;
  }>
): Array<{ title: string; tokenJson: unknown }> {
  return entities
    .filter((e) => e.profileSlug === "brand-token-set")
    .filter((e) => {
      const s = e.properties?.["token-status"];
      return s === undefined || s === null || s === "" || s === "active";
    })
    .map((e) => ({
      mode:
        e.properties?.["token-mode"] === "base" || !e.properties?.["token-mode"]
          ? 0
          : 1,
      title: e.title ?? "",
      tokenJson: e.properties?.["token-json"],
    }))
    .sort(
      (a, b) =>
        a.mode - b.mode || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
    )
    .map(({ title, tokenJson }) => ({ title, tokenJson }));
}
