/**
 * Brand kit → Open Design design-system project (`format=od-design-system`).
 *
 * Pure, beside `renderCss` / `renderFrameMd`: given a canonical
 * {@link BrandKitInput} (and optionally an approved token set), it returns the
 * JSON string `{manifest, designMd, tokensCss, files[]}` that a worker writes
 * into an Open Design project. Nothing here is hashed: the kit hash is over the
 * kit input only, so adding this format changes no existing hash.
 *
 * `OD_TOKEN_SCHEMA` mirrors Open Design's `TOKEN_SCHEMA` (nexu-io/open-design
 * tag open-design-v0.26.1, `packages/contracts/src/design-systems/
 * token-schema.ts`): 56 names, each with the value Open Design's `default`
 * brand uses (`design-systems/default/tokens.css`). A test pins the names.
 */
import type { BrandKitInput } from "./index.js";

export type OdTokenLayer = "A1-identity" | "A1-structure" | "A2" | "B-slot";

export interface OdTokenSpec {
  readonly name: string;
  readonly layer: OdTokenLayer;
  /** Open Design's default value (a `var()` alias for B-slot tokens). */
  readonly fallback: string;
}

const SANS = '"Inter", -apple-system, system-ui, sans-serif';

export const OD_TOKEN_SCHEMA: readonly OdTokenSpec[] = [
  { name: "--bg", layer: "A1-identity", fallback: "#fafafa" },
  { name: "--surface", layer: "A1-identity", fallback: "#ffffff" },
  { name: "--surface-warm", layer: "B-slot", fallback: "var(--surface)" },
  { name: "--fg", layer: "A1-identity", fallback: "#111111" },
  { name: "--fg-2", layer: "B-slot", fallback: "var(--fg)" },
  { name: "--muted", layer: "A1-identity", fallback: "#6b6b6b" },
  { name: "--meta", layer: "B-slot", fallback: "var(--muted)" },
  { name: "--border", layer: "A1-identity", fallback: "#e5e5e5" },
  { name: "--border-soft", layer: "B-slot", fallback: "var(--border)" },
  { name: "--accent", layer: "A1-identity", fallback: "#2f6feb" },
  { name: "--accent-on", layer: "A2", fallback: "#ffffff" },
  {
    name: "--accent-hover",
    layer: "A2",
    fallback: "color-mix(in oklab, var(--accent), black 8%)",
  },
  {
    name: "--accent-active",
    layer: "A2",
    fallback: "color-mix(in oklab, var(--accent), black 14%)",
  },
  { name: "--success", layer: "A2", fallback: "#16a34a" },
  { name: "--warn", layer: "A2", fallback: "#eab308" },
  { name: "--danger", layer: "A2", fallback: "#dc2626" },
  { name: "--font-display", layer: "A1-identity", fallback: SANS },
  { name: "--font-body", layer: "A1-identity", fallback: SANS },
  {
    name: "--font-mono",
    layer: "A2",
    fallback:
      'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
  },
  { name: "--text-xs", layer: "A1-structure", fallback: "12px" },
  { name: "--text-sm", layer: "A1-structure", fallback: "14px" },
  { name: "--text-base", layer: "A1-structure", fallback: "16px" },
  { name: "--text-lg", layer: "A1-structure", fallback: "20px" },
  { name: "--text-xl", layer: "A1-structure", fallback: "24px" },
  { name: "--text-2xl", layer: "A1-structure", fallback: "32px" },
  { name: "--text-3xl", layer: "A1-structure", fallback: "48px" },
  { name: "--text-4xl", layer: "A1-structure", fallback: "64px" },
  { name: "--leading-body", layer: "A1-structure", fallback: "1.5" },
  { name: "--leading-tight", layer: "A1-structure", fallback: "1.2" },
  { name: "--tracking-display", layer: "A1-structure", fallback: "-0.01em" },
  { name: "--space-1", layer: "A2", fallback: "4px" },
  { name: "--space-2", layer: "A2", fallback: "8px" },
  { name: "--space-3", layer: "A2", fallback: "12px" },
  { name: "--space-4", layer: "A2", fallback: "16px" },
  { name: "--space-5", layer: "A2", fallback: "20px" },
  { name: "--space-6", layer: "A2", fallback: "24px" },
  { name: "--space-8", layer: "A2", fallback: "32px" },
  { name: "--space-12", layer: "A2", fallback: "48px" },
  { name: "--section-y-desktop", layer: "A1-structure", fallback: "80px" },
  { name: "--section-y-tablet", layer: "A1-structure", fallback: "48px" },
  { name: "--section-y-phone", layer: "A1-structure", fallback: "32px" },
  { name: "--radius-sm", layer: "A2", fallback: "8px" },
  { name: "--radius-md", layer: "A2", fallback: "12px" },
  { name: "--radius-lg", layer: "A2", fallback: "16px" },
  { name: "--radius-pill", layer: "A2", fallback: "9999px" },
  { name: "--elev-flat", layer: "A2", fallback: "none" },
  { name: "--elev-ring", layer: "A2", fallback: "0 0 0 1px var(--border)" },
  {
    name: "--elev-raised",
    layer: "A2",
    fallback: "0 2px 8px color-mix(in oklab, var(--fg), transparent 92%)",
  },
  {
    name: "--focus-ring",
    layer: "A2",
    fallback: "0 0 0 3px color-mix(in oklab, var(--accent), transparent 70%)",
  },
  { name: "--motion-fast", layer: "A2", fallback: "150ms" },
  { name: "--motion-base", layer: "A2", fallback: "200ms" },
  {
    name: "--ease-standard",
    layer: "A2",
    fallback: "cubic-bezier(0.2, 0, 0, 1)",
  },
  { name: "--container-max", layer: "A1-structure", fallback: "1200px" },
  {
    name: "--container-gutter-desktop",
    layer: "A1-structure",
    fallback: "24px",
  },
  {
    name: "--container-gutter-tablet",
    layer: "A1-structure",
    fallback: "16px",
  },
  { name: "--container-gutter-phone", layer: "A1-structure", fallback: "12px" },
];

export const OD_TOKEN_NAMES: readonly string[] = OD_TOKEN_SCHEMA.map(
  (t) => t.name
);

/** Brand color role → the Open Design token it fills (first role listed wins). */
export const OD_COLOR_ROLE_TOKENS: ReadonlyArray<
  readonly [token: string, roles: readonly string[]]
> = [
  ["--bg", ["background"]],
  ["--surface", ["surface"]],
  ["--surface-warm", ["surface-elevated"]],
  ["--fg", ["text"]],
  ["--muted", ["text-muted"]],
  ["--border", ["border"]],
  ["--accent", ["primary", "accent"]],
  ["--success", ["success"]],
  ["--warn", ["warning"]],
  ["--danger", ["error"]],
];

/** Font role → token (first role listed wins). */
export const OD_FONT_ROLE_TOKENS: ReadonlyArray<
  readonly [token: string, roles: readonly string[]]
> = [
  ["--font-display", ["heading", "display"]],
  ["--font-body", ["body"]],
  ["--font-mono", ["mono"]],
];

/** An approved brand-token-set row's parsed token-json (flat or nested). */
export type OdTokenOverrides = Readonly<Record<string, string>>;

export interface OdDesignSystemOptions {
  /** Structure tokens from an approved token set; absent → Open Design defaults. */
  tokens?: OdTokenOverrides;
}

export interface OdDesignSystemFile {
  kind: string;
  name: string;
  url?: string;
  documentId?: string;
  fileId?: string;
}

export interface OdDesignSystemProject {
  manifest: {
    schemaVersion: "od-design-system-project/v1";
    id: string;
    name: string;
    category: "Brand & Marketing";
    description: string;
    source: { type: "local"; origin: "Synap pod brand kit" };
    files: { design: "DESIGN.md"; tokens: "tokens.css" };
    guessed: string[];
  };
  designMd: string;
  tokensCss: string;
  files: OdDesignSystemFile[];
}

// ── Token set reading ────────────────────────────────────────────────────────

const SCHEMA_NAMES = new Set(OD_TOKEN_NAMES);

function flatten(
  value: unknown,
  path: string[],
  out: Map<string, string>
): void {
  if (typeof value === "string" || typeof value === "number") {
    out.set(path.join("-"), String(value));
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      flatten(v, [...path, k], out);
  }
}

/**
 * The Open Design tokens carried by a `token-json` string. Accepts a flat map
 * (`{"--text-xs": "12px"}` or `{"text-xs": …}`) or a nested one
 * (`{"text": {"xs": …}}`); keys that are not one of the 56 schema names are
 * dropped. Invalid JSON yields no tokens (a bad row must not break a kit).
 */
export function odTokensFromTokenJson(raw: unknown): OdTokenOverrides {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const flat = new Map<string, string>();
  flatten(parsed, [], flat);
  const out: Record<string, string> = {};
  for (const [k, v] of [...flat].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = `--${k.replace(/^-+/, "").toLowerCase()}`;
    const value = cssValue(v);
    if (SCHEMA_NAMES.has(name) && value) out[name] = value;
  }
  return out;
}

/**
 * The overrides of the pod's approved token set among Brand Library rows:
 * `token-status` `active` (missing = active), preferring mode `base`, then the
 * lowest title; undefined when no row carries usable tokens.
 */
export function odTokensFromEntities(
  entities: ReadonlyArray<{
    profileSlug: string;
    title: string;
    properties: Record<string, unknown>;
  }>
): OdTokenOverrides | undefined {
  const rows = entities
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
      tokens: odTokensFromTokenJson(e.properties?.["token-json"]),
    }))
    .filter((r) => Object.keys(r.tokens).length)
    .sort(
      (a, b) =>
        a.mode - b.mode || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
    );
  return rows[0]?.tokens;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A CSS value that cannot close a declaration or block, or open markup. */
function cssValue(value: string): string {
  return value
    .replace(/[;{}<>\\\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Normalized ASCII slug of a brand name; `brand` when nothing survives. */
export function odSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "brand"
  );
}

function rgb(hex: string): [number, number, number] | undefined {
  let h = hex.replace(/^#/, "");
  if (h.length === 3 || h.length === 4)
    h = h
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length !== 6 && h.length !== 8) return undefined;
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n)
    ? undefined
    : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const ra = rgb(a);
  const rb = rgb(b);
  if (!ra || !rb) return 1;
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `#ffffff` or `#111111`, whichever reads better on the accent. */
export function accentOn(accent: string): string {
  return contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#111111")
    ? "#ffffff"
    : "#111111";
}

function fontStack(f: BrandKitInput["fonts"][number]): string {
  const family = `"${cssValue(f.family).replace(/"/g, "'")}"`;
  return f.fallback ? `${family}, ${cssValue(f.fallback)}` : family;
}

function firstByRole<T extends { role: string }>(
  items: T[],
  roles: readonly string[]
): T | undefined {
  for (const r of roles) {
    const hit = items.find((i) => i.role === r);
    if (hit) return hit;
  }
  return undefined;
}

const FILE_KINDS = new Set(["logo", "wordmark", "symbol", "monogram", "font"]);

// ── Renderer ─────────────────────────────────────────────────────────────────

/** Resolve all 56 tokens: value + whether it came from the brand. */
export function resolveOdTokens(
  kit: BrandKitInput,
  options: OdDesignSystemOptions = {}
): Array<{ name: string; value: string; guessed: boolean }> {
  const values = new Map<string, string>();
  for (const [token, roles] of OD_COLOR_ROLE_TOKENS) {
    const c = firstByRole(kit.colors, roles);
    if (c) values.set(token, c.hex);
  }
  for (const [token, roles] of OD_FONT_ROLE_TOKENS) {
    const f = firstByRole(kit.fonts, roles);
    if (f) values.set(token, fontStack(f));
  }
  const accent = values.get("--accent");
  if (accent) {
    // Derived from the accent, not guessed: measured contrast and the
    // schema's own state formulas.
    values.set("--accent-on", accentOn(accent));
    values.set(
      "--accent-hover",
      "color-mix(in oklab, var(--accent), black 8%)"
    );
    values.set(
      "--accent-active",
      "color-mix(in oklab, var(--accent), black 14%)"
    );
  }
  // An approved token set fills what the roles did not.
  for (const [name, value] of Object.entries(options.tokens ?? {}))
    if (!values.has(name)) values.set(name, value);

  return OD_TOKEN_SCHEMA.map((t) => {
    const v = values.get(t.name);
    return { name: t.name, value: v ?? t.fallback, guessed: v === undefined };
  });
}

function renderTokensCss(tokens: ReturnType<typeof resolveOdTokens>): string {
  return (
    [":root {", ...tokens.map((t) => `  ${t.name}: ${t.value};`), "}"].join(
      "\n"
    ) + "\n"
  );
}

function renderDesignMd(
  kit: BrandKitInput,
  name: string,
  tokens: ReturnType<typeof resolveOdTokens>,
  files: OdDesignSystemFile[]
): string {
  const L: string[] = [`# ${oneLine(name)}`];
  const none = "_Nothing defined in the brand kit._";

  L.push("", "## Overview", "");
  if (kit.identity?.tagline) L.push(oneLine(kit.identity.tagline), "");
  if (kit.identity?.website)
    L.push(`Website: ${oneLine(kit.identity.website)}`, "");
  L.push(
    `Generated from the ${oneLine(name)} brand kit in the Synap pod. \`tokens.css\` is the machine-readable form; paste its \`:root\` block into every artifact.`
  );

  L.push("", "## Voice", "");
  const voiceLines: string[] = [];
  if (kit.identity?.voiceSummary)
    voiceLines.push(oneLine(kit.identity.voiceSummary));
  for (const v of kit.voice) {
    const facets = [
      v.tone ? `tone: ${oneLine(v.tone)}` : "",
      v.traits ? `traits: ${oneLine(v.traits)}` : "",
    ].filter(Boolean);
    voiceLines.push(
      `- **${oneLine(v.name || "Voice")}** ${facets.join(" · ")}`.trimEnd()
    );
    for (const l of (v.body ?? "").split(/\r?\n/))
      if (l.trim()) voiceLines.push(`  - ${oneLine(l)}`);
  }
  L.push(...(voiceLines.length ? voiceLines : [none]));

  const rule = (r: BrandKitInput["rules"][number]) =>
    `- ${r.kind ? `[${oneLine(r.kind)}] ` : ""}${oneLine(r.content)}`;
  const mandatory = kit.rules.filter((r) => r.severity === "mandatory");
  const other = kit.rules.filter((r) => r.severity !== "mandatory");
  L.push("", "## Mandatory rules", "");
  L.push(...(mandatory.length ? mandatory.map(rule) : [none]));
  L.push("", "## Guidelines", "");
  L.push(...(other.length ? other.map(rule) : [none]));

  L.push("", "## Colours", "");
  if (kit.colors.length) {
    for (const c of kit.colors)
      L.push(
        `- **${oneLine(c.name || c.role)}** (${oneLine(c.role)}): \`${c.hex}\`${c.usage ? ` — ${oneLine(c.usage)}` : ""}`
      );
  } else L.push(none);
  L.push("", "Token bindings:", "");
  for (const t of tokens.filter(
    (x) =>
      /^--(bg|surface|fg|muted|border|accent|success|warn|danger)/.test(
        x.name
      ) && !x.guessed
  ))
    L.push(`- \`${t.name}\`: \`${t.value}\``);

  L.push("", "## Typography", "");
  if (kit.fonts.length) {
    for (const f of kit.fonts)
      L.push(
        `- **${oneLine(f.role)}**: ${oneLine(f.family)}${f.fallback ? ` (fallback ${oneLine(f.fallback)})` : ""}`
      );
  } else L.push(none);

  L.push("", "## Assets", "");
  L.push(
    ...(files.length
      ? files.map((f) => `- ${f.kind}: ${oneLine(f.name)}`)
      : [none])
  );

  const guessed = tokens.filter((t) => t.guessed);
  L.push("", "## Guessed values", "");
  if (guessed.length) {
    L.push(
      "These tokens have no source in the brand kit; they carry Open Design's default value and need a human decision:",
      "",
      ...guessed.map((t) => `- \`${t.name}\`: \`${t.value}\``)
    );
  } else L.push("Every token has a brand source.");
  return L.join("\n") + "\n";
}

/** Render the Open Design design-system project of a (canonical) kit. */
export function renderOdDesignSystem(
  kit: BrandKitInput,
  options: OdDesignSystemOptions = {}
): string {
  const name = kit.identity?.name?.trim() || "Brand";
  const tokens = resolveOdTokens(kit, options);

  const files: OdDesignSystemFile[] = [
    ...kit.assets
      .filter(
        (a) => FILE_KINDS.has(a.kind) && (a.url || a.documentId || a.fileId)
      )
      .map((a) => ({
        kind: a.kind,
        name: a.name,
        ...(a.url ? { url: a.url } : {}),
        ...(a.documentId ? { documentId: a.documentId } : {}),
        ...(a.fileId ? { fileId: a.fileId } : {}),
      })),
    ...kit.fonts
      .filter((f) => f.url)
      .map((f) => ({ kind: "font", name: f.name || f.family, url: f.url! })),
  ];

  const project: OdDesignSystemProject = {
    manifest: {
      schemaVersion: "od-design-system-project/v1",
      id: odSlug(name),
      name,
      category: "Brand & Marketing",
      description: oneLine(
        kit.identity?.tagline ??
          `${name} brand design system from the Synap pod.`
      ),
      source: { type: "local", origin: "Synap pod brand kit" },
      files: { design: "DESIGN.md", tokens: "tokens.css" },
      guessed: tokens.filter((t) => t.guessed).map((t) => t.name),
    },
    designMd: renderDesignMd(kit, name, tokens, files),
    tokensCss: renderTokensCss(tokens),
    files,
  };
  return JSON.stringify(project, null, 2) + "\n";
}
