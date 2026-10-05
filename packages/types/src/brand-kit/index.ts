/**
 * Brand kit — the ONE projection of a Brand Library workspace into a portable
 * kit (JSON, CSS custom properties, or a HyperFrames `frame-md` design spec).
 *
 * Pure and dependency-free: it runs unchanged in the browser, Node, the
 * Intelligence Service and the CLI. The pod's `GET /api/hub/brand/kit` door is
 * the reader that feeds it entities; every other surface that needs a kit asks
 * that door (or calls these two functions) instead of re-deriving one.
 *
 * Input entities are Brand Library rows (`synap-app/packages/workspace-templates/
 * src/brand-library.yaml`), read by their REAL property slugs:
 *   - brand-identity     brand-tagline · brand-website · brand-voice-summary · brand-status
 *   - brand-color        color-role · color-hex · color-token-name · color-usage · color-status
 *   - brand-font         font-role · font-family · font-fallback · font-url · font-status
 *   - brand-asset        asset-kind · asset-variant · asset-document-id · asset-usage · asset-status
 *   - brand-voice-guide  voice-tone-descriptors · voice-personality-traits ·
 *                        voice-vocabulary · voice-example-do · voice-example-dont · voice-status
 *   - brand-rule         rule-kind · rule-content · rule-severity
 *
 * Exclusion rules (stated once, here, and pinned by tests):
 *   - colors: excluded when `color-status` is `deprecated`, or when `color-hex`
 *     is not a valid hex colour (an invalid value can't be rendered and would
 *     otherwise be injected verbatim into CSS). Missing status = template
 *     default `approved`.
 *   - fonts: included ONLY when `font-status` is `active` (missing = template
 *     default `active`), so `draft` and `deprecated` are excluded.
 *   - assets: included ONLY when `asset-status` is `approved` (missing =
 *     template default `approved`), so `draft` and `deprecated` are excluded.
 *   - voice guides: excluded when `voice-status` is `deprecated` or `draft`
 *     (missing = template default `approved`).
 *   - rules: excluded when they carry no content (neither `rule-content` nor a
 *     title).
 *   - identity: the first identity in canonical order whose `brand-status` is
 *     not `archived`, preferring `active` over `draft`.
 *
 * Determinism: every list is sorted canonically, so the same set of entities
 * in ANY order yields byte-identical content and the same `hash`. The hash is
 * cyrb53 (53-bit, hex) over the canonical JSON of exactly the fields above —
 * a content hash, not a counter. It is the same for every format, so it names
 * the kit's version rather than one rendering of it.
 */

export type BrandKitFormat = "json" | "css" | "frame-md";

export const BRAND_KIT_FORMATS: readonly BrandKitFormat[] = [
  "json",
  "css",
  "frame-md",
];

/** The Brand Library kinds a kit reads. */
export const BRAND_KIT_PROFILE_SLUGS = [
  "brand-identity",
  "brand-color",
  "brand-font",
  "brand-asset",
  "brand-voice-guide",
  "brand-rule",
] as const;

export interface BrandKitInput {
  identity?: {
    name: string;
    tagline?: string;
    website?: string;
    voiceSummary?: string;
  };
  colors: Array<{
    name: string;
    role: string;
    hex: string;
    tokenName?: string;
    usage?: string;
    status?: string;
  }>;
  fonts: Array<{
    name: string;
    role: string;
    family: string;
    fallback?: string;
    url?: string;
  }>;
  assets: Array<{
    name: string;
    kind: string;
    variant?: string;
    documentId?: string;
    usage?: string;
    status?: string;
  }>;
  voice: Array<{ name: string; tone?: string; traits?: string; body?: string }>;
  rules: Array<{
    name: string;
    kind?: string;
    content: string;
    severity?: string;
  }>;
}

export interface BrandKitExport {
  format: BrandKitFormat;
  content: string;
  hash: string;
}

export interface BrandKitSourceEntity {
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
  body?: string;
}

// ── Reading entities ─────────────────────────────────────────────────────────

function str(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `#RRGGBB`-style lowercase hex, or undefined when the value is not a hex colour. */
function normalizeHex(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = HEX_RE.exec(raw.trim());
  return m ? `#${m[1]!.toLowerCase()}` : undefined;
}

/** Drop undefined keys so canonical JSON never depends on how a field was absent. */
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function joinSections(
  parts: Array<[string, string | undefined]>
): string | undefined {
  const lines = parts
    .filter((p): p is [string, string] => !!p[1])
    .map(([label, text]) => `${label}: ${text}`);
  return lines.length ? lines.join("\n") : undefined;
}

const IDENTITY_STATUS_RANK: Record<string, number> = { active: 0, draft: 1 };

/**
 * Project Brand Library entities into a {@link BrandKitInput}. Rows of any
 * other kind are ignored. See the module header for the exclusion rules.
 */
export function brandKitFromEntities(
  entities: Array<BrandKitSourceEntity>
): BrandKitInput {
  const kit: BrandKitInput = {
    colors: [],
    fonts: [],
    assets: [],
    voice: [],
    rules: [],
  };
  const identities: Array<{
    rank: number;
    value: NonNullable<BrandKitInput["identity"]>;
  }> = [];

  for (const e of entities) {
    const p = e.properties ?? {};
    const name = (e.title ?? "").trim();
    switch (e.profileSlug) {
      case "brand-identity": {
        const status = str(p, "brand-status") ?? "active";
        if (status === "archived") break;
        identities.push({
          rank: IDENTITY_STATUS_RANK[status] ?? 2,
          value: compact({
            name,
            tagline: str(p, "brand-tagline"),
            website: str(p, "brand-website"),
            voiceSummary: str(p, "brand-voice-summary"),
          }),
        });
        break;
      }
      case "brand-color": {
        const status = str(p, "color-status") ?? "approved";
        if (status === "deprecated") break;
        const hex = normalizeHex(str(p, "color-hex"));
        if (!hex) break;
        kit.colors.push(
          compact({
            name,
            role: str(p, "color-role") ?? "custom",
            hex,
            tokenName: str(p, "color-token-name"),
            usage: str(p, "color-usage"),
            status,
          })
        );
        break;
      }
      case "brand-font": {
        const status = str(p, "font-status") ?? "active";
        if (status !== "active") break;
        const family = str(p, "font-family") ?? (name || undefined);
        if (!family) break;
        kit.fonts.push(
          compact({
            name,
            role: str(p, "font-role") ?? "body",
            family,
            fallback: str(p, "font-fallback"),
            url: str(p, "font-url"),
          })
        );
        break;
      }
      case "brand-asset": {
        const status = str(p, "asset-status") ?? "approved";
        if (status !== "approved") break;
        kit.assets.push(
          compact({
            name,
            kind: str(p, "asset-kind") ?? "other",
            variant: str(p, "asset-variant"),
            documentId: str(p, "asset-document-id"),
            usage: str(p, "asset-usage"),
            status,
          })
        );
        break;
      }
      case "brand-voice-guide": {
        const status = str(p, "voice-status") ?? "approved";
        if (status === "deprecated" || status === "draft") break;
        const body =
          (typeof e.body === "string" && e.body.trim()) ||
          joinSections([
            ["Vocabulary", str(p, "voice-vocabulary")],
            ["Do", str(p, "voice-example-do")],
            ["Don't", str(p, "voice-example-dont")],
          ]);
        kit.voice.push(
          compact({
            name,
            tone: str(p, "voice-tone-descriptors"),
            traits: str(p, "voice-personality-traits"),
            body: body || undefined,
          })
        );
        break;
      }
      case "brand-rule": {
        const content = str(p, "rule-content") ?? (name || undefined);
        if (!content) break;
        kit.rules.push(
          compact({
            name,
            kind: str(p, "rule-kind"),
            content,
            severity: str(p, "rule-severity"),
          })
        );
        break;
      }
      default:
        break;
    }
  }

  if (identities.length) {
    identities.sort(
      (a, b) =>
        a.rank - b.rank || cmp(canonicalJson(a.value), canonicalJson(b.value))
    );
    kit.identity = identities[0]!.value;
  }
  return canonicalBrandKit(kit);
}

// ── Canonical form + hash ────────────────────────────────────────────────────

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with object keys sorted at every depth — stable regardless of key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => cmp(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortBy<T>(items: T[], key: (t: T) => string): T[] {
  return items
    .map((item) => ({ item, k: key(item), full: canonicalJson(item) }))
    .sort((a, b) => cmp(a.k, b.k) || cmp(a.full, b.full))
    .map((x) => x.item);
}

const SEVERITY_ORDER: Record<string, string> = {
  mandatory: "0",
  important: "1",
  guideline: "2",
};

/**
 * The canonical form of a kit: every list sorted by a stable key, undefined
 * fields dropped. Two kits with the same content compare equal byte-for-byte.
 */
function canonicalBrandKit(input: BrandKitInput): BrandKitInput {
  const out: BrandKitInput = {
    colors: sortBy(
      input.colors.map(compact),
      (c) => `${c.role}\u0000${c.name}`
    ),
    fonts: sortBy(input.fonts.map(compact), (f) => `${f.role}\u0000${f.name}`),
    assets: sortBy(
      input.assets.map(compact),
      (a) => `${a.kind}\u0000${a.name}`
    ),
    voice: sortBy(input.voice.map(compact), (v) => v.name),
    rules: sortBy(
      input.rules.map(compact),
      (r) => `${SEVERITY_ORDER[r.severity ?? ""] ?? "3"}\u0000${r.name}`
    ),
  };
  if (input.identity) out.identity = compact(input.identity);
  return out;
}

/** cyrb53 — a small, well-distributed, dependency-free 53-bit string hash. */
function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

// ── Renderers ────────────────────────────────────────────────────────────────

/** A CSS/YAML key segment: lowercase `[a-z0-9-]`, never empty. */
function keySegment(raw: string, fallback: string): string {
  const k = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return k || fallback;
}

/** Unique role keys in canonical order: a repeated role gets `-2`, `-3`, … */
function roleKeys<T extends { role: string }>(
  items: T[],
  fallback: string
): Array<[string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keySegment(item.role, fallback);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [n === 1 ? base : `${base}-${n}`, item];
  });
}

/** Strip characters that could close a CSS declaration/block or open markup. */
function cssSafe(value: string): string {
  return value
    .replace(/[;{}<>\\\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fontStack(f: BrandKitInput["fonts"][number]): string {
  const family = `"${cssSafe(f.family).replace(/"/g, "'")}"`;
  return f.fallback ? `${family}, ${cssSafe(f.fallback)}` : family;
}

function renderCss(kit: BrandKitInput): string {
  const lines = [":root {"];
  for (const [key, c] of roleKeys(kit.colors, "color")) {
    lines.push(`  --brand-${key}: ${c.hex};`);
  }
  for (const [key, f] of roleKeys(kit.fonts, "body")) {
    lines.push(`  --brand-font-${key}: ${fontStack(f)};`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** One line of prose: newlines collapsed so user text cannot forge a heading. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function renderFrameMd(kit: BrandKitInput): string {
  const y = (v: string) => JSON.stringify(v); // a JSON string is a valid YAML scalar
  const lines: string[] = ["---"];
  if (kit.identity?.name) lines.push(`name: ${y(kit.identity.name)}`);
  const colors = roleKeys(kit.colors, "color");
  if (colors.length) {
    lines.push("colors:");
    for (const [key, c] of colors) lines.push(`  ${key}: ${y(c.hex)}`);
  } else {
    lines.push("colors: {}");
  }
  const fonts = roleKeys(kit.fonts, "body");
  if (fonts.length) {
    lines.push("typography:");
    for (const [key, f] of fonts) lines.push(`  ${key}: ${y(f.family)}`);
  } else {
    lines.push("typography: {}");
  }
  lines.push("---", "");

  lines.push(`# ${oneLine(kit.identity?.name || "Brand")}`);
  if (kit.identity?.tagline) lines.push("", oneLine(kit.identity.tagline));
  if (kit.identity?.website)
    lines.push("", `Website: ${oneLine(kit.identity.website)}`);

  if (kit.identity?.voiceSummary || kit.voice.length) {
    lines.push("", "## Voice");
    if (kit.identity?.voiceSummary)
      lines.push("", oneLine(kit.identity.voiceSummary));
    for (const v of kit.voice) {
      const facets = [
        v.tone ? `tone: ${oneLine(v.tone)}` : "",
        v.traits ? `traits: ${oneLine(v.traits)}` : "",
      ].filter(Boolean);
      lines.push("", `### ${oneLine(v.name || "Voice")}`);
      if (facets.length) lines.push(facets.join(" · "));
      if (v.body) {
        for (const l of v.body.split(/\r?\n/))
          if (l.trim()) lines.push(`- ${oneLine(l)}`);
      }
    }
  }

  const mandatory = kit.rules.filter((r) => r.severity === "mandatory");
  const other = kit.rules.filter((r) => r.severity !== "mandatory");
  const ruleLine = (r: BrandKitInput["rules"][number]) =>
    `- ${r.kind ? `[${oneLine(r.kind)}] ` : ""}${oneLine(r.content)}`;
  if (mandatory.length) {
    lines.push("", "## Mandatory rules", "", ...mandatory.map(ruleLine));
  }
  if (other.length) {
    lines.push("", "## Guidelines", "", ...other.map(ruleLine));
  }
  return lines.join("\n") + "\n";
}

/**
 * Render a kit in one format. The input is canonicalized first, so callers may
 * pass a hand-built kit in any order and still get stable content and hash.
 */
export function exportBrandKit(
  input: BrandKitInput,
  format: BrandKitFormat
): BrandKitExport {
  const kit = canonicalBrandKit(input);
  const hash = cyrb53(canonicalJson(kit));
  let content: string;
  switch (format) {
    case "json":
      content = JSON.stringify(kit, null, 2) + "\n";
      break;
    case "css":
      content = renderCss(kit);
      break;
    case "frame-md":
      content = renderFrameMd(kit);
      break;
    default: {
      const never: never = format;
      throw new Error(`Unknown brand kit format: ${String(never)}`);
    }
  }
  return { format, content, hash };
}
