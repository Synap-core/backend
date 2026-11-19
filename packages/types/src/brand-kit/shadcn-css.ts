/**
 * Brand token set → shadcn's CSS variables (`format=css-shadcn`, plan
 * 0fc746f4 §2.3 and W6).
 *
 * A project's brand sets VALUES for Synap's own DTCG paths (D1); a client
 * app built on shadcn (every Website Factory app) reads its own vocabulary
 * (`--background`, `--primary`, `--radius`…). This is the ONE projection
 * between the two: the Design app draws a client app's kit in its project's
 * brand with it, and a factory app can write its `app/brand.css` from it.
 *
 * Each shadcn variable takes the first Synap path the file sets, in order
 * (`--card` is the card surface, else the paper). A variable none of its
 * paths sets is absent: the app keeps its own value. Aliases are followed
 * inside the file (a shadcn app has no `--synap-*` to point at). Modes as
 * `synap-css`: a token with a light value lands in `light` and `dark`,
 * without one in `vars`. Declarations only, no selector: the caller scopes
 * them.
 */
import { dtcgLeaves, isDtcg } from "./dtcg.js";
import { dtcgCssText, type SynapCssDeclarations } from "./synap-css.js";

/** shadcn variable → the Synap DTCG paths it reads, first set wins. */
export const DTCG_TO_SHADCN: ReadonlyArray<
  readonly [variable: string, paths: readonly string[]]
> = [
  ["--background", ["surface.background"]],
  ["--foreground", ["ink.color"]],
  ["--card", ["surface.background-surface", "surface.paper"]],
  ["--card-foreground", ["ink.color"]],
  ["--popover", ["surface.background-surface", "surface.paper"]],
  ["--popover-foreground", ["ink.color"]],
  ["--primary", ["brand.primary-button", "brand.primary"]],
  ["--primary-foreground", ["brand.primary-button-text"]],
  ["--secondary", ["surface.background-hover", "brand.secondary-light"]],
  ["--secondary-foreground", ["ink.color"]],
  ["--muted", ["surface.background-hover"]],
  ["--muted-foreground", ["ink.muted-foreground", "ink.color-secondary"]],
  ["--accent", ["surface.background-hover"]],
  ["--accent-foreground", ["ink.color"]],
  ["--destructive", ["status.error-ink", "status.error"]],
  ["--border", ["border.border-color"]],
  ["--input", ["border.border-color-hover", "border.border-color"]],
  ["--ring", ["border.border-color-focus", "brand.primary"]],
  ["--radius", ["radius.radius-control"]],
];

/** shadcn's `{vars, light, dark}` from a parsed DTCG document; all empty when it is not DTCG. */
export function shadcnCssFromDtcg(parsed: unknown): SynapCssDeclarations {
  const out: SynapCssDeclarations = { vars: {}, light: {}, dark: {} };
  if (!isDtcg(parsed)) return out;
  const leaves = new Map<string, unknown>();
  const lights = new Map<string, unknown>();
  dtcgLeaves(parsed, [], leaves, lights);
  for (const [variable, paths] of DTCG_TO_SHADCN) {
    const path = paths.find((p) => leaves.has(p) || lights.has(p));
    if (!path) continue;
    const value = leaves.has(path)
      ? dtcgCssText(leaves.get(path), leaves)
      : undefined;
    const light = lights.has(path)
      ? dtcgCssText(lights.get(path), leaves)
      : undefined;
    if (value && light) {
      out.dark[variable] = value;
      out.light[variable] = light;
    } else if (value) out.vars[variable] = value;
    else if (light) out.light[variable] = light;
  }
  return out;
}

/** `format=css-shadcn`: `{vars, light, dark}` as JSON; all empty when the brand has no DTCG set. */
export function renderShadcnCss(
  dtcg: Record<string, unknown> | undefined
): string {
  return JSON.stringify(shadcnCssFromDtcg(dtcg), null, 2) + "\n";
}
