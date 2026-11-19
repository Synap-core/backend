/**
 * Brand token set → Synap's `--synap-*` custom properties (`format=synap-css`)
 * and the token set itself (`format=dtcg`).
 *
 * A project's brand sets VALUES for Synap's own DTCG paths; the names never
 * vary per project (plan 0fc746f4 D1). `DTCG_TO_SYNAP` lists the paths a brand
 * may set (D2: colour, space, radius, type, grid) with the name Synap's token
 * build gives each (`@synap-core/design-tokens` `tokens-lib.ts`: path
 * `<group>.<leaf>`, property `--synap-<leaf>`). A path the file does not set
 * is absent from the output, so the caller keeps Synap's own value there.
 *
 * Modes follow Synap's convention: `$value` is the dark value, and
 * `$extensions["com.synap.modes"].light` the light one. A token with a light
 * value lands in `dark` and `light`; a token without one lands in `vars`
 * (both modes). The output is declarations only, no selector: the caller
 * scopes them (the Design app, to one frame's page root).
 *
 * Values: a DTCG 2025.10 colour object (`{colorSpace: "srgb", components,
 * alpha?, hex?}`) is its hex, or `rgba()` when it carries an alpha (the
 * spelling Synap's build uses); a dimension `{value, unit}` is `<value><unit>`
 * (`0` alone); a font stack array is a CSS stack; a `typography` composite is
 * its five parts (`--synap-type-body-{family,size,weight,leading,tracking}`).
 * An alias to a path of the table stays LIVE (`var(--synap-…)`), so the
 * scoped value is the brand's when the brand sets the target and Synap's
 * otherwise; any other alias is followed inside the file.
 */
import {
  activeTokenSets,
  cssValue,
  dtcgLeaves,
  dtcgText,
  isDtcg,
} from "./dtcg.js";

/**
 * The Synap DTCG paths a brand may set, by group (`<group>.<leaf>`), each
 * named `--synap-<leaf>`. The AI family is never here (locked across every
 * theme), nor derived tokens (tones, spatial materials, elevation).
 *
 * Grid, gutter, section and breakpoint (plan §2.1, §2.5) are new Synap tokens,
 * one per window class of the page grammar (`compact` < 600 ≤ `medium` <
 * 1024 ≤ `expanded`, `PAGE_BREAKPOINTS`).
 */
const SYNAP_BRAND_LEAVES: ReadonlyArray<
  readonly [group: string, leaves: readonly string[]]
> = [
  // Colour
  [
    "surface",
    [
      "background",
      "background-surface",
      "background-hover",
      "background-press",
      "paper",
    ],
  ],
  ["ink", ["color", "color-secondary", "muted", "muted-foreground"]],
  [
    "brand",
    [
      "primary",
      "primary-hover",
      "primary-light",
      "primary-button",
      "primary-button-text",
      "primary-ink",
      "secondary",
      "secondary-hover",
      "secondary-light",
    ],
  ],
  [
    "status",
    [
      "success",
      "success-light",
      "success-ink",
      "error",
      "error-light",
      "error-ink",
      "warning",
      "warning-light",
      "warning-ink",
      "info",
      "info-light",
      "info-ink",
    ],
  ],
  [
    "border",
    [
      "border-color",
      "border-color-hover",
      "border-color-subtle",
      "border-color-focus",
    ],
  ],
  // Space
  [
    "space",
    [
      "space-025",
      "space-050",
      "space-075",
      "space-100",
      "space-125",
      "space-150",
      "space-200",
      "space-250",
      "space-300",
      "space-400",
      "space-500",
      "space-600",
      "space-800",
      "space-1000",
      "space-1200",
    ],
  ],
  // Radius
  [
    "radius",
    [
      "radius-pill",
      "radius-container",
      "radius-floating",
      "radius-xs",
      "radius-chip",
      "radius-1",
      "radius-2",
      "radius-3",
      "radius-4",
      "radius-5",
      "radius-overlay",
      "radius-modal",
      "radius-round",
      "radius-card",
      "radius-control",
    ],
  ],
  // Type
  ["font", ["font-heading", "font-body", "font-mono"]],
  [
    "type",
    [
      "text-3xs",
      "text-2xs",
      "text-xs",
      "text-sm",
      "text-base",
      "text-md",
      "text-lg",
      "text-xl",
      "text-2xl",
      "text-3xl",
      "text-4xl",
      "text-5xl",
    ],
  ],
  [
    "weight",
    [
      "weight-regular",
      "weight-medium",
      "weight-semibold",
      "weight-bold",
      "weight-extrabold",
    ],
  ],
  [
    "leading",
    [
      "leading-none",
      "leading-tight",
      "leading-snug",
      "leading-normal",
      "leading-relaxed",
      "leading-loose",
    ],
  ],
  [
    "typography",
    [
      "type-display",
      "type-title",
      "type-heading",
      "type-body",
      "type-caption",
      "type-label",
      "type-row-title",
      "type-num",
      "type-num-large",
    ],
  ],
  // Grid, page gutter, section rhythm, breakpoints (one per window class)
  [
    "grid",
    [
      "grid-columns-compact",
      "grid-columns-medium",
      "grid-columns-expanded",
      "grid-gap-compact",
      "grid-gap-medium",
      "grid-gap-expanded",
    ],
  ],
  [
    "page",
    ["page-gutter-compact", "page-gutter-medium", "page-gutter-expanded"],
  ],
  ["section", ["section-y-compact", "section-y-medium", "section-y-expanded"]],
  ["breakpoint", ["bp-medium", "bp-expanded"]],
];

/** Synap DTCG path → the `--synap-*` property it sets. */
export const DTCG_TO_SYNAP: ReadonlyArray<
  readonly [path: string, token: string]
> = SYNAP_BRAND_LEAVES.flatMap(([group, leaves]) =>
  leaves.map((leaf) => [`${group}.${leaf}`, `--synap-${leaf}`] as const)
);

const SYNAP_NAME_BY_PATH = new Map(DTCG_TO_SYNAP);

/** Typography composite part → property suffix (Synap's `TYPO_SUFFIX`). */
const TYPOGRAPHY_PARTS: ReadonlyArray<readonly [part: string, suffix: string]> =
  [
    ["fontFamily", "family"],
    ["fontSize", "size"],
    ["fontWeight", "weight"],
    ["lineHeight", "leading"],
    ["letterSpacing", "tracking"],
  ];

/** Declarations only, no selector: the caller scopes them. */
export interface SynapCssDeclarations {
  /** Both modes. */
  vars: Record<string, string>;
  /** Light mode only. */
  light: Record<string, string>;
  /** Dark mode only. */
  dark: Record<string, string>;
}

const byte = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255);

function colorText(o: Record<string, unknown>): string | undefined {
  const comps = o["components"];
  const rgb =
    Array.isArray(comps) &&
    comps.length === 3 &&
    comps.every((c) => typeof c === "number")
      ? (comps as number[]).map(byte)
      : undefined;
  const alpha = o["alpha"];
  if (typeof alpha === "number" && rgb)
    return `rgba(${rgb.join(", ")}, ${alpha})`;
  const hex = o["hex"];
  if (typeof hex === "string" && /^#[0-9a-f]{3,8}$/i.test(hex))
    return hex.toLowerCase();
  return rgb
    ? "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("")
    : undefined;
}

/** A Synap-path value as CSS text, before sanitizing; undefined = unreadable. */
function synapText(
  value: unknown,
  self: string,
  leaves: Map<string, unknown>,
  depth = 0,
  /** false: every alias is followed to its value (a projection whose names are not Synap's). */
  liveAliases = true
): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string") {
    const ref = /^\{([^}]+)\}$/.exec(value.trim());
    if (ref) {
      const name = liveAliases ? SYNAP_NAME_BY_PATH.get(ref[1]!) : undefined;
      // An alias to a Synap path stays live; to itself it would be a cycle.
      if (name) return name === self ? undefined : `var(${name})`;
      return synapText(
        leaves.get(ref[1]!),
        self,
        leaves,
        depth + 1,
        liveAliases
      );
    }
    return value.trim();
  }
  if (typeof value === "number" || Array.isArray(value))
    return dtcgText(value, leaves);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("colorSpace" in o || "components" in o || "hex" in o)
      return colorText(o);
    if (typeof o["value"] === "number" && typeof o["unit"] === "string") {
      if (!/^(px|rem|em|ms|s|%)$/.test(o["unit"])) return undefined;
      return o["value"] === 0 ? "0" : `${o["value"]}${o["unit"]}`;
    }
  }
  return undefined;
}

/** The `--synap-*` declarations a parsed DTCG document sets. */
export function synapCssFromDtcg(parsed: unknown): SynapCssDeclarations {
  const out: SynapCssDeclarations = { vars: {}, light: {}, dark: {} };
  if (!isDtcg(parsed)) return out;
  const leaves = new Map<string, unknown>();
  const lights = new Map<string, unknown>();
  dtcgLeaves(parsed, [], leaves, lights);

  const text = (v: unknown, name: string) => {
    const t = synapText(v, name, leaves);
    const value = t === undefined ? "" : cssValue(t);
    return value || undefined;
  };

  for (const [path, name] of DTCG_TO_SYNAP) {
    if (!leaves.has(path)) continue;
    const raw = leaves.get(path);
    // A typography role: its five parts, theme-invariant.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (TYPOGRAPHY_PARTS.some(([part]) => part in o)) {
        for (const [part, suffix] of TYPOGRAPHY_PARTS) {
          const v = part in o ? text(o[part], `${name}-${suffix}`) : undefined;
          if (v) out.vars[`${name}-${suffix}`] = v;
        }
        continue;
      }
    }
    const value = text(raw, name);
    const light = lights.has(path) ? text(lights.get(path), name) : undefined;
    if (value && light) {
      out.dark[name] = value;
      out.light[name] = light;
    } else if (value) out.vars[name] = value;
    else if (light) out.light[name] = light;
  }
  return out;
}

/**
 * The parsed DTCG document of the brand's approved token set (the first
 * active row, base mode first, whose `token-json` is DTCG), or undefined when
 * the brand has none.
 */
export function dtcgTokenSetFromEntities(
  entities: ReadonlyArray<{
    profileSlug: string;
    title: string;
    properties: Record<string, unknown>;
  }>
): Record<string, unknown> | undefined {
  for (const set of activeTokenSets(entities)) {
    if (typeof set.tokenJson !== "string" || !set.tokenJson.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(set.tokenJson);
      if (isDtcg(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // An unparseable row is not the brand's token set: try the next one.
    }
  }
  return undefined;
}

/** `format=dtcg`: the token set as a file; `{}` when the brand has none. */
export function renderDtcg(dtcg: Record<string, unknown> | undefined): string {
  return JSON.stringify(dtcg ?? {}, null, 2) + "\n";
}

/** `format=synap-css`: `{vars, light, dark}` as JSON; all empty when none. */
export function renderSynapCss(
  dtcg: Record<string, unknown> | undefined
): string {
  return JSON.stringify(synapCssFromDtcg(dtcg), null, 2) + "\n";
}

/**
 * A DTCG value as plain CSS text, every alias followed inside the file (no
 * live `var(--synap-…)`: for a projection onto names that are not Synap's,
 * `shadcn-css.ts`). Sanitized; undefined when unreadable.
 */
export function dtcgCssText(
  value: unknown,
  leaves: Map<string, unknown>
): string | undefined {
  const t = synapText(value, "", leaves, 0, false);
  const v = t === undefined ? "" : cssValue(t);
  return v || undefined;
}
