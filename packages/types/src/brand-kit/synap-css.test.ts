import { describe, expect, it } from "vitest";
import {
  BRAND_KIT_FORMATS,
  brandKitFromEntities,
  exportBrandKit,
  type BrandKitSourceEntity,
} from "./index.js";
import {
  DTCG_TO_SYNAP,
  dtcgTokenSetFromEntities,
  synapCssFromDtcg,
} from "./synap-css.js";

/** A project's brand: values for Synap's own DTCG paths, plus noise. */
const BRAND_DTCG = {
  $description: "CRM brand",
  surface: {
    background: {
      $type: "color",
      // `$value` is dark; the light value rides Synap's mode extension.
      $value: { colorSpace: "srgb", components: [0.1, 0.1, 0.1], hex: "#1A1A1A" },
      $extensions: {
        "com.synap.modes": {
          light: { colorSpace: "srgb", components: [1, 1, 1], hex: "#FFFFFF" },
        },
      },
    },
  },
  brand: {
    primary: { $type: "color", $value: "#B67A38" },
    "primary-light": {
      $type: "color",
      $value: { colorSpace: "srgb", components: [0.2, 0.4, 0.6], alpha: 0.12 },
    },
  },
  space: {
    $type: "dimension",
    "space-200": { $value: { value: 10, unit: "px" } },
    "space-300": { $value: { value: 14, unit: "px" } },
  },
  radius: {
    $type: "dimension",
    "radius-container": { $value: { value: 6, unit: "px" } },
    // An alias to a Synap path stays live; to itself it is dropped.
    "radius-card": { $value: "{radius.radius-container}" },
    "radius-control": { $value: "{radius.radius-control}" },
  },
  font: {
    "font-body": { $type: "fontFamily", $value: ["Source Sans 3", "sans-serif"] },
  },
  type: {
    "text-md": { $type: "dimension", $value: { value: 15, unit: "px" } },
  },
  typography: {
    "type-body": {
      $type: "typography",
      $value: {
        fontFamily: "{font.font-body}",
        fontSize: "{type.text-md}",
        fontWeight: 400,
        lineHeight: 1.5,
        letterSpacing: { value: 0, unit: "px" },
      },
    },
  },
  grid: {
    "grid-columns-compact": { $type: "number", $value: 4 },
    "grid-columns-medium": { $type: "number", $value: 8 },
    "grid-columns-expanded": { $type: "number", $value: 12 },
    "grid-gap-expanded": { $type: "dimension", $value: "{space.space-300}" },
  },
  page: {
    "page-gutter-expanded": {
      $type: "dimension",
      $value: { value: 32, unit: "px" },
    },
  },
  section: {
    "section-y-compact": { $type: "dimension", $value: { value: 40, unit: "px" } },
  },
  breakpoint: {
    "bp-medium": { $type: "dimension", $value: { value: 600, unit: "px" } },
    "bp-expanded": { $type: "dimension", $value: { value: 1024, unit: "px" } },
  },
  // Not a Synap path: never declared.
  theme: { paper: { ground: { $value: "#F5F4ED" } } },
  // A brand value cannot close the declaration.
  ink: { color: { $type: "color", $value: "#111; } body { display:none" } },
};

describe("DTCG_TO_SYNAP", () => {
  it("names every path the way Synap's token build does: --synap-<leaf>", () => {
    for (const [path, token] of DTCG_TO_SYNAP) {
      const [group, leaf, ...rest] = path.split(".");
      expect(rest).toEqual([]);
      expect(group).toBeTruthy();
      expect(token).toBe(`--synap-${leaf}`);
    }
    const names = DTCG_TO_SYNAP.map(([, t]) => t);
    expect(new Set(names).size).toBe(names.length);
  });

  it("pins the grid, gutter, section and breakpoint names (one per window class)", () => {
    const layout = DTCG_TO_SYNAP.filter(([p]) =>
      /^(grid|page|section|breakpoint)\./.test(p)
    );
    expect(layout).toEqual([
      ["grid.grid-columns-compact", "--synap-grid-columns-compact"],
      ["grid.grid-columns-medium", "--synap-grid-columns-medium"],
      ["grid.grid-columns-expanded", "--synap-grid-columns-expanded"],
      ["grid.grid-gap-compact", "--synap-grid-gap-compact"],
      ["grid.grid-gap-medium", "--synap-grid-gap-medium"],
      ["grid.grid-gap-expanded", "--synap-grid-gap-expanded"],
      ["page.page-gutter-compact", "--synap-page-gutter-compact"],
      ["page.page-gutter-medium", "--synap-page-gutter-medium"],
      ["page.page-gutter-expanded", "--synap-page-gutter-expanded"],
      ["section.section-y-compact", "--synap-section-y-compact"],
      ["section.section-y-medium", "--synap-section-y-medium"],
      ["section.section-y-expanded", "--synap-section-y-expanded"],
      ["breakpoint.bp-medium", "--synap-bp-medium"],
      ["breakpoint.bp-expanded", "--synap-bp-expanded"],
    ]);
  });

  it("never lets a brand set the locked AI family", () => {
    expect(DTCG_TO_SYNAP.some(([, t]) => t.startsWith("--synap-ai"))).toBe(
      false
    );
  });
});

describe("synapCssFromDtcg", () => {
  it("projects colour, space, radius, type and grid to --synap-* with a light/dark split", () => {
    expect(synapCssFromDtcg(BRAND_DTCG)).toEqual({
      vars: {
        "--synap-color": "#111 body display:none",
        "--synap-primary": "#B67A38",
        "--synap-primary-light": "rgba(51, 102, 153, 0.12)",
        "--synap-space-200": "10px",
        "--synap-space-300": "14px",
        "--synap-radius-container": "6px",
        "--synap-radius-card": "var(--synap-radius-container)",
        "--synap-font-body": '"Source Sans 3", sans-serif',
        "--synap-text-md": "15px",
        "--synap-type-body-family": "var(--synap-font-body)",
        "--synap-type-body-size": "var(--synap-text-md)",
        "--synap-type-body-weight": "400",
        "--synap-type-body-leading": "1.5",
        "--synap-type-body-tracking": "0",
        "--synap-grid-columns-compact": "4",
        "--synap-grid-columns-medium": "8",
        "--synap-grid-columns-expanded": "12",
        "--synap-grid-gap-expanded": "var(--synap-space-300)",
        "--synap-page-gutter-expanded": "32px",
        "--synap-section-y-compact": "40px",
        "--synap-bp-medium": "600px",
        "--synap-bp-expanded": "1024px",
      },
      light: { "--synap-background": "#ffffff" },
      dark: { "--synap-background": "#1a1a1a" },
    });
  });

  it("declares nothing for a file that sets no Synap path, or is not DTCG", () => {
    const empty = { vars: {}, light: {}, dark: {} };
    expect(
      synapCssFromDtcg({ theme: { paper: { ground: { $value: "#fff" } } } })
    ).toEqual(empty);
    // Synap's own "Base Tokens" row: a flat alias map, not DTCG.
    expect(
      synapCssFromDtcg({ colors: { primary: "var(--synap-primary)" } })
    ).toEqual(empty);
    expect(synapCssFromDtcg(undefined)).toEqual(empty);
  });
});

const e = (
  profileSlug: string,
  title: string,
  properties: Record<string, unknown>
): BrandKitSourceEntity => ({ profileSlug, title, properties });

describe("dtcgTokenSetFromEntities", () => {
  it("takes the approved DTCG set, base mode first, skipping flat, draft and broken rows", () => {
    const set = (title: string, props: Record<string, unknown>) =>
      e("brand-token-set", title, props);
    const brand = { brand: { primary: { $value: "#123456" } } };
    const got = dtcgTokenSetFromEntities([
      set("A flat", { "token-json": '{"colors":{"primary":"#000"}}' }),
      set("B broken", { "token-json": "{not json" }),
      set("C draft", {
        "token-status": "draft",
        "token-json": JSON.stringify({ brand: { primary: { $value: "#ff0000" } } }),
      }),
      set("D dark", {
        "token-mode": "dark",
        "token-json": JSON.stringify({ brand: { primary: { $value: "#00ff00" } } }),
      }),
      set("E base", { "token-mode": "base", "token-json": JSON.stringify(brand) }),
    ]);
    expect(got).toEqual(brand);
    expect(dtcgTokenSetFromEntities([])).toBeUndefined();
  });
});

describe("exportBrandKit — dtcg and synap-css", () => {
  const kit = brandKitFromEntities([
    e("brand-color", "Ochre", { "color-role": "primary", "color-hex": "#B67A38" }),
  ]);

  it("is listed among the door's formats", () => {
    expect(BRAND_KIT_FORMATS).toEqual(
      expect.arrayContaining(["dtcg", "synap-css"])
    );
  });

  it("serves the token set as a file and as Synap declarations, under one token-set hash", () => {
    const dtcg = exportBrandKit(kit, "dtcg", { dtcg: BRAND_DTCG });
    const css = exportBrandKit(kit, "synap-css", { dtcg: BRAND_DTCG });
    expect(JSON.parse(dtcg.content)).toEqual(BRAND_DTCG);
    expect(JSON.parse(css.content)).toEqual(synapCssFromDtcg(BRAND_DTCG));
    expect(dtcg.hash).toMatch(/^[0-9a-f]{14}$/);
    expect(css.hash).toBe(dtcg.hash);
    // The kit formats keep the kit's hash; the token set never enters it.
    expect(exportBrandKit(kit, "json").hash).not.toBe(dtcg.hash);
    expect(
      exportBrandKit(kit, "dtcg", {
        dtcg: { brand: { primary: { $value: "#000000" } } },
      }).hash
    ).not.toBe(dtcg.hash);
  });

  it("renders an empty set when the brand has no DTCG token set", () => {
    expect(exportBrandKit(kit, "dtcg").content).toBe("{}\n");
    expect(JSON.parse(exportBrandKit(kit, "synap-css").content)).toEqual({
      vars: {},
      light: {},
      dark: {},
    });
  });
});
