import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heroUIColors, readTokens } from "./lib/ochre-theme";
// HeroUI v2 plugin — wires CSS variables + tailwind-variants strings.
// We import via require() so Next.js's TS loader handles it cleanly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { heroui } = require("@heroui/react");

/**
 * Pod Admin theme — denser, calmer sibling of the Synap apps.
 *
 * Dashboard density:
 *   • Pane radius     24
 *   • Card radius     16  (`lg`)
 *   • Inner pill      8   (`sm`)
 *
 * COLOURS come from the ochre token SSOT (decision 53e110df): the mirrored
 * `app/synap-tokens.css` is read here and turned into HeroUI's palette by
 * `lib/ochre-theme.ts`, so no colour is written in this file. The status
 * palette is the only place red/amber/green appear: green=healthy,
 * amber=stale/expiring, red=down/expired, grey=unknown. Never decorative.
 */
const tokensCss = readFileSync(join(__dirname, "app/synap-tokens.css"), "utf8");

/** A HeroUI colour as a Tailwind colour that keeps opacity modifiers. */
const heroColor = (name: string) =>
  `hsl(var(--heroui-${name}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx,mjs}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "Geist",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        heading: ["var(--font-heading)", "Fraunces", "Georgia", "serif"],
        mono: [
          "var(--font-mono)",
          "JetBrains Mono",
          "ui-monospace",
          "monospace",
        ],
      },
      letterSpacing: {
        tightest: "-0.025em",
      },
      colors: {
        // Status — the only place red/amber/green appear as decoration.
        // Theme-varying: each is the HeroUI semantic colour of the mode.
        status: {
          healthy: heroColor("success"),
          stale: heroColor("warning"),
          down: heroColor("danger"),
          unknown: heroColor("default-500"),
        },
      },
    },
  },
  plugins: [
    // The sidebar's remembered collapse, set on <html> before paint
    // (`lib/nav-collapsed.ts`), so its widths are CSS rather than state.
    plugin(({ addVariant }) =>
      addVariant("nav-collapsed", "html[data-nav-collapsed] &")
    ),
    // @heroui/theme 2.4.x writes Tailwind v4 class names; this app builds with
    // Tailwind v3, which has no `outline-solid`. Its fields carry
    // `!outline-solid outline-transparent`, so without the rule the browser's
    // own `outline: auto` focus ring (blue) drew around every input.
    plugin(({ addUtilities }) =>
      addUtilities({ ".outline-solid": { "outline-style": "solid" } })
    ),
    heroui({
      defaultTheme: "dark",
      defaultExtendTheme: "dark",
      layout: {
        radius: {
          // Concentric: pane 24 → card 16 → inner 8.
          small: "8px",
          medium: "12px",
          large: "16px",
        },
        borderWidth: {
          small: "1px",
          medium: "1px",
          large: "1px",
        },
      },
      themes: {
        light: { colors: heroUIColors(readTokens(tokensCss, "light")) },
        dark: { colors: heroUIColors(readTokens(tokensCss, "dark")) },
      },
    }),
  ],
};

export default config;
