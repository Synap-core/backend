import type { Config } from "tailwindcss";
// HeroUI v2 plugin — wires CSS variables + tailwind-variants strings.
// We import via require() so Next.js's TS loader handles it cleanly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { heroui } = require("@heroui/react");

/**
 * Pod Admin theme — denser, calmer sibling of Eve OS.
 *
 * Dashboard density vs Eve's launcher density:
 *   • Pane radius     24  (Eve uses 32)
 *   • Card radius     16  (Eve uses 20 — `lg`)
 *   • Inner pill      8   (Eve uses 12 — `sm`)
 *
 * Same emerald primary as Eve so brand reads consistent. Status palette
 * is the only place we use red/amber: green=healthy, amber=stale/expiring,
 * red=down/expired, grey=unknown. Never decorative.
 */
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
          "DM Sans",
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
        status: {
          healthy: "#34D399",
          stale: "#FBBF24",
          down: "#F87171",
          unknown: "#94A3B8",
        },
      },
    },
  },
  plugins: [
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
        // -------------------------------------------------------------
        // LIGHT — warm off-white, deep ink (matches Eve)
        // -------------------------------------------------------------
        light: {
          colors: {
            background: "#FAF9F6",
            foreground: "#1A1A19",
            divider: "#E5E2DA",
            focus: "#10B981",
            content1: "#FFFFFF",
            content2: "#F4F2EE",
            content3: "#ECEAE3",
            content4: "#E0DCD2",
            default: {
              50: "#FAF9F6",
              100: "#F4F2EE",
              200: "#ECEAE3",
              300: "#D9D5C9",
              400: "#A8A49A",
              500: "#6B6963",
              600: "#4A4844",
              700: "#2F2E2B",
              800: "#1F1F1D",
              900: "#1A1A19",
              DEFAULT: "#F4F2EE",
              foreground: "#1A1A19",
            },
            primary: {
              50: "#ECFDF5",
              100: "#D1FAE5",
              200: "#A7F3D0",
              300: "#6EE7B7",
              400: "#34D399",
              500: "#10B981",
              600: "#059669",
              700: "#047857",
              800: "#065F46",
              900: "#064E3B",
              DEFAULT: "#10B981",
              foreground: "#FFFFFF",
            },
            success: { DEFAULT: "#10B981", foreground: "#FFFFFF" },
            warning: { DEFAULT: "#D97706", foreground: "#FFFFFF" },
            danger: { DEFAULT: "#DC2626", foreground: "#FFFFFF" },
          },
        },
        // -------------------------------------------------------------
        // DARK — near-black, faint green tint (matches Eve)
        // -------------------------------------------------------------
        dark: {
          colors: {
            background: "#0B0C0A",
            foreground: "#ECECEA",
            divider: "#23262B",
            focus: "#34D399",
            content1: "#15171A",
            content2: "#1B1E22",
            content3: "#22262B",
            content4: "#2A2E34",
            default: {
              50: "#15171A",
              100: "#1B1E22",
              200: "#22262B",
              300: "#2A2E34",
              400: "#5C6068",
              500: "#8B8B85",
              600: "#A8A8A2",
              700: "#C9C9C4",
              800: "#DEDEDA",
              900: "#ECECEA",
              DEFAULT: "#1B1E22",
              foreground: "#ECECEA",
            },
            primary: {
              50: "#052E22",
              100: "#064E3B",
              200: "#065F46",
              300: "#047857",
              400: "#059669",
              500: "#10B981",
              600: "#34D399",
              700: "#6EE7B7",
              800: "#A7F3D0",
              900: "#D1FAE5",
              DEFAULT: "#34D399",
              foreground: "#062418",
            },
            success: { DEFAULT: "#34D399", foreground: "#062418" },
            warning: { DEFAULT: "#F59E0B", foreground: "#1A1304" },
            danger: { DEFAULT: "#F87171", foreground: "#2A0A0A" },
          },
        },
      },
    }),
  ],
};

export default config;
