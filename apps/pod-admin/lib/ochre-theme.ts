/**
 * pod-admin's HeroUI theme, derived from the ochre token SSOT.
 *
 * The values live in ONE place: `app/synap-tokens.css`, a byte-for-byte mirror
 * of synap-app `packages/design-tokens/src/synap-tokens.css` (pinned equal by
 * `__tripwires__/ochre-tokens.test.ts`). pod-admin sits in the backend pnpm
 * workspace and cannot import `@synap-core/design-tokens` or
 * `@synap-core/heroui-preset`, so it mirrors the file and DERIVES its HeroUI
 * palette from it here. Nothing below is a colour literal: every value is a
 * `--synap-*` token, or a token composited over another (HeroUI needs opaque
 * colours: an alpha it parses is baked into the shared Tailwind colour and the
 * last theme's alpha wins for both modes).
 *
 * Decision 53e110df (founder, 28 Oct 2026): pod-admin moves to the ochre
 * tokens and Fraunces / Geist / JetBrains Mono.
 */

export type ThemeMode = "light" | "dark";
export type Tokens = Record<string, string>;

type Rgba = { r: number; g: number; b: number; a: number };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of the first rule whose selector list starts with `selector`. */
function blockDeclarations(css: string, selector: string): Tokens {
  const start = css.indexOf(selector);
  if (start < 0) return {};
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const out: Tokens = {};
  for (const m of css
    .slice(open + 1, close)
    .matchAll(/--synap-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

/**
 * The `--synap-*` tokens of one mode, read from the SSOT stylesheet.
 * Dark is the `:root` block (the SSOT's default); light is `:root` with the
 * `[data-theme="light"]` block over it (it re-states only what changes).
 */
export function readTokens(css: string, mode: ThemeMode): Tokens {
  const clean = stripComments(css);
  const root = blockDeclarations(clean, ":root {");
  if (mode === "dark") return root;
  return {
    ...root,
    ...blockDeclarations(clean, '[data-theme="light"],\nhtml.light,\n.light {'),
  };
}

function resolve(tokens: Tokens, name: string, depth = 0): string {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`--synap-${name} is not declared`);
  const ref = /^var\(--synap-([a-z0-9-]+)\)$/.exec(raw);
  if (ref && depth < 8) return resolve(tokens, ref[1], depth + 1);
  return raw;
}

export function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
      value
    );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`Not a colour pod-admin can derive from: ${value}`);
}

function toHex({ r, g, b }: Rgba): string {
  const h = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** `top` laid over the opaque `ground`: what the eye sees, as an opaque hex. */
function over(top: string, ground: string): string {
  const t = parseColor(top);
  const g = parseColor(ground);
  return toHex({
    r: t.r * t.a + g.r * (1 - t.a),
    g: t.g * t.a + g.g * (1 - t.a),
    b: t.b * t.a + g.b * (1 - t.a),
    a: 1,
  });
}

function mix(from: string, to: string, amount: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  return toHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
    a: 1,
  });
}

type Shade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

/**
 * A HeroUI 50…900 scale through three tokens: 50 sits near `from` (the page),
 * 500 IS `mid`, 900 IS `to`. In dark the page is dark and the ink light, so the
 * scale inverts by itself, as HeroUI's dark scales do.
 */
function scale(from: string, mid: string, to: string): Record<Shade, string> {
  return {
    50: mix(from, mid, 0.08),
    100: mix(from, mid, 0.16),
    200: mix(from, mid, 0.3),
    300: mix(from, mid, 0.5),
    400: mix(from, mid, 0.75),
    500: toHex(parseColor(mid)),
    600: mix(mid, to, 0.25),
    700: mix(mid, to, 0.5),
    800: mix(mid, to, 0.75),
    900: toHex(parseColor(to)),
  };
}

/** The HeroUI `themes.<mode>.colors` for pod-admin, all from the tokens. */
export function heroUIColors(tokens: Tokens) {
  const t = (name: string) => resolve(tokens, name);
  const page = t("background");
  const paper = t("paper");
  const ink = t("color");
  // Text set ON a filled control: the SSOT measures it on the primary button
  // fill, and the status inks below are at least as far from it in both modes.
  const onFill = t("primary-button-text");
  const hover = over(t("background-hover"), paper);
  const defaultScale = scale(page, t("muted"), ink);
  return {
    background: page,
    foreground: ink,
    divider: over(t("border-color"), page),
    focus: t("focus-ring"),
    content1: paper,
    content2: hover,
    content3: over(t("background-press"), paper),
    content4: over(t("background-press"), hover),
    default: { ...defaultScale, DEFAULT: defaultScale[200], foreground: ink },
    primary: {
      ...scale(page, t("primary"), t("primary-ink")),
      DEFAULT: t("primary-button"),
      foreground: onFill,
    },
    secondary: { DEFAULT: t("secondary"), foreground: onFill },
    // Status colours are READ far more than filled in pod-admin
    // (`text-danger`, `text-warning`, `text-success`), so each is its
    // readable `-ink` partner: >= 4.5:1 on the page in both modes.
    success: { DEFAULT: t("success-ink"), foreground: onFill },
    warning: { DEFAULT: t("warning-ink"), foreground: onFill },
    danger: { DEFAULT: t("error-ink"), foreground: onFill },
  };
}

/** Relative luminance contrast (WCAG 2.x) between two opaque colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (value: string) => {
    const { r, g, b: bl } = parseColor(value);
    const ch = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
