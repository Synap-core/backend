import { describe, expect, it } from "vitest";
import {
  brandKitFromEntities,
  exportBrandKit,
  type BrandKitSourceEntity,
} from "./index.js";
import {
  accentOn,
  odSlug,
  odTokensFromEntities,
  odTokensFromTokenJson,
  OD_TOKEN_NAMES,
  type OdDesignSystemProject,
} from "./open-design.js";

/** Open Design `TOKEN_SCHEMA` names at tag open-design-v0.26.1 (token-schema.ts), pinned. */
const OD_0_26_1_NAMES = [
  "--bg",
  "--surface",
  "--surface-warm",
  "--fg",
  "--fg-2",
  "--muted",
  "--meta",
  "--border",
  "--border-soft",
  "--accent",
  "--accent-on",
  "--accent-hover",
  "--accent-active",
  "--success",
  "--warn",
  "--danger",
  "--font-display",
  "--font-body",
  "--font-mono",
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl",
  "--text-4xl",
  "--leading-body",
  "--leading-tight",
  "--tracking-display",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--space-12",
  "--section-y-desktop",
  "--section-y-tablet",
  "--section-y-phone",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-pill",
  "--elev-flat",
  "--elev-ring",
  "--elev-raised",
  "--focus-ring",
  "--motion-fast",
  "--motion-base",
  "--ease-standard",
  "--container-max",
  "--container-gutter-desktop",
  "--container-gutter-tablet",
  "--container-gutter-phone",
];

const e = (
  profileSlug: string,
  title: string,
  properties: Record<string, unknown> = {}
): BrandKitSourceEntity => ({ profileSlug, title, properties });

const color = (title: string, role: string, hex: string) =>
  e("brand-color", title, { "color-role": role, "color-hex": hex });

const FIXTURE: BrandKitSourceEntity[] = [
  e("brand-identity", "Société Acme!", {
    "brand-tagline": "Make it ship",
    "brand-voice-summary": "Plain, warm, exact.",
  }),
  color("Paper", "background", "#F5EAD4"),
  color("Card", "surface", "#ffffff"),
  color("Raised", "surface-elevated", "#efe3c8"),
  color("Ink", "text", "#111111"),
  color("Quiet", "text-muted", "#6b6b6b"),
  color("Line", "border", "#d8ccb0"),
  color("Ochre", "primary", "#D9A35B"),
  color("Other", "accent", "#ff0000"),
  color("Go", "success", "#00aa00"),
  color("Careful", "warning", "#ddaa00"),
  color("Stop", "error", "#cc0000"),
  e("brand-font", "H", {
    "font-role": "heading",
    "font-family": "Fraunces",
    "font-fallback": "Georgia, serif",
    "font-url": "https://fonts.test/f.woff2",
  }),
  e("brand-font", "B", { "font-role": "body", "font-family": "Inter" }),
  e("brand-font", "M", { "font-role": "mono", "font-family": "Plex Mono" }),
  e("brand-asset", "Logo", {
    "asset-kind": "logo",
    "asset-url": "https://cdn.test/logo.svg",
  }),
  e("brand-asset", "Photo", {
    "asset-kind": "photo",
    "asset-url": "https://cdn.test/p.jpg",
  }),
  e("brand-asset", "Mark", {
    "asset-kind": "symbol",
    "asset-file-id": "file-9",
  }),
  e("brand-voice-guide", "General", { "voice-tone-descriptors": "warm" }),
  e("brand-rule", "Clear", {
    "rule-content": "Keep clearspace.",
    "rule-severity": "mandatory",
  }),
];

const od = (
  entities: BrandKitSourceEntity[],
  tokens?: Record<string, string>
) =>
  JSON.parse(
    exportBrandKit(
      brandKitFromEntities(entities),
      "od-design-system",
      tokens ? { tokens } : {}
    ).content
  ) as OdDesignSystemProject;

const declared = (css: string) =>
  [...css.matchAll(/^\s+(--[a-z0-9-]+):\s*(.+);$/gm)].map(
    (m) => [m[1]!, m[2]!] as const
  );

describe("od-design-system — tokens.css", () => {
  it("pins the exported schema names to Open Design v0.26.1 (56 tokens)", () => {
    expect(OD_0_26_1_NAMES).toHaveLength(56);
    expect([...OD_TOKEN_NAMES].sort()).toEqual([...OD_0_26_1_NAMES].sort());
  });

  it("declares every schema token exactly once, for a full and an empty kit", () => {
    for (const entities of [FIXTURE, []]) {
      const names = declared(od(entities).tokensCss).map(([n]) => n);
      expect(names).toEqual([...OD_TOKEN_NAMES]);
      expect(od(entities).tokensCss.startsWith(":root {")).toBe(true);
    }
  });

  it("maps color roles (primary beats accent) and font roles", () => {
    const css = Object.fromEntries(declared(od(FIXTURE).tokensCss));
    expect(css["--bg"]).toBe("#f5ead4");
    expect(css["--surface"]).toBe("#ffffff");
    expect(css["--surface-warm"]).toBe("#efe3c8");
    expect(css["--fg"]).toBe("#111111");
    expect(css["--muted"]).toBe("#6b6b6b");
    expect(css["--border"]).toBe("#d8ccb0");
    expect(css["--accent"]).toBe("#d9a35b");
    expect(css["--success"]).toBe("#00aa00");
    expect(css["--warn"]).toBe("#ddaa00");
    expect(css["--danger"]).toBe("#cc0000");
    expect(css["--font-display"]).toBe('"Fraunces", Georgia, serif');
    expect(css["--font-body"]).toBe('"Inter"');
    expect(css["--font-mono"]).toBe('"Plex Mono"');
  });

  it("falls back to the accent role when there is no primary", () => {
    const css = Object.fromEntries(
      declared(od([color("A", "accent", "#123456")]).tokensCss)
    );
    expect(css["--accent"]).toBe("#123456");
  });

  it("picks --accent-on by measured contrast", () => {
    expect(accentOn("#d9a35b")).toBe("#111111");
    expect(accentOn("#1a2b5c")).toBe("#ffffff");
    const dark = Object.fromEntries(
      declared(od([color("A", "primary", "#1a2b5c")]).tokensCss)
    );
    expect(dark["--accent-on"]).toBe("#ffffff");
    const light = Object.fromEntries(declared(od(FIXTURE).tokensCss));
    expect(light["--accent-on"]).toBe("#111111");
  });

  it("applies token-set structure tokens, never over a brand color", () => {
    const p = od(FIXTURE, { "--text-4xl": "156px", "--bg": "#000000" });
    const css = Object.fromEntries(declared(p.tokensCss));
    expect(css["--text-4xl"]).toBe("156px");
    expect(css["--bg"]).toBe("#f5ead4");
    expect(p.manifest.guessed).not.toContain("--text-4xl");
  });

  it("keeps user text from closing the :root block", () => {
    const p = od([
      e("brand-font", "B", {
        "font-role": "body",
        "font-family": "X; } body { display:none",
      }),
    ]);
    expect(p.tokensCss.match(/\}/g)).toHaveLength(1);
  });
});

describe("od-design-system — manifest, guessed, files, design.md", () => {
  it("builds the manifest", () => {
    const m = od(FIXTURE).manifest;
    expect(m).toMatchObject({
      schemaVersion: "od-design-system-project/v1",
      id: "societe-acme",
      name: "Société Acme!",
      category: "Brand & Marketing",
      description: "Make it ship",
      source: { type: "local", origin: "Synap pod brand kit" },
      files: { design: "DESIGN.md", tokens: "tokens.css" },
    });
    expect(odSlug("  ÄÖ — 9 lives ")).toBe("ao-9-lives");
    expect(odSlug("!!!")).toBe("brand");
  });

  it("lists exactly the tokens with no brand source as guessed", () => {
    const p = od(FIXTURE);
    const bySource = new Set([
      "--bg",
      "--surface",
      "--surface-warm",
      "--fg",
      "--muted",
      "--border",
      "--accent",
      "--success",
      "--warn",
      "--danger",
      "--font-display",
      "--font-body",
      "--font-mono",
      "--accent-on",
      "--accent-hover",
      "--accent-active",
    ]);
    expect(p.manifest.guessed).toEqual(
      OD_TOKEN_NAMES.filter((n) => !bySource.has(n))
    );
    expect(p.manifest.guessed).toContain("--text-base");
    expect(p.manifest.guessed).toContain("--fg-2");
    // An empty kit guesses everything.
    expect(od([]).manifest.guessed).toEqual([...OD_TOKEN_NAMES]);
    expect(od([]).manifest.name).toBe("Brand");
  });

  it("has at least 7 sections, always, ending with Guessed values", () => {
    for (const entities of [FIXTURE, []]) {
      const heads = [...od(entities).designMd.matchAll(/^## (.+)$/gm)].map(
        (m) => m[1]
      );
      expect(heads.length).toBeGreaterThanOrEqual(7);
      expect(heads.at(-1)).toBe("Guessed values");
      expect(heads).toEqual(
        expect.arrayContaining(["Voice", "Colours", "Typography"])
      );
    }
    expect(od(FIXTURE).designMd).toContain("Keep clearspace.");
  });

  it("cannot be given a forged heading by user text", () => {
    const p = od([
      e("brand-rule", "R", {
        "rule-content": "x\n## Forged",
        "rule-severity": "mandatory",
      }),
    ]);
    expect(p.designMd).not.toMatch(/^## Forged/m);
  });

  it("lists logo and font sources with no bytes", () => {
    const { files } = od(FIXTURE);
    expect(files).toEqual([
      { kind: "logo", name: "Logo", url: "https://cdn.test/logo.svg" },
      { kind: "symbol", name: "Mark", fileId: "file-9" },
      { kind: "font", name: "H", url: "https://fonts.test/f.woff2" },
    ]);
  });
});

describe("od-design-system — token set reading", () => {
  it("reads flat and nested token-json, dropping non-schema keys and bad JSON", () => {
    expect(
      odTokensFromTokenJson(
        '{"--text-xs":"11px","text":{"sm":"13px"},"nope":"1"}'
      )
    ).toEqual({ "--text-xs": "11px", "--text-sm": "13px" });
    expect(odTokensFromTokenJson("{not json")).toEqual({});
    expect(odTokensFromTokenJson(undefined)).toEqual({});
  });

  it("reads a DTCG file: explicit mappings, refs followed, slide sizes left out", () => {
    const dtcg = JSON.stringify({
      $description: "x",
      color: {
        $type: "color",
        ink: { $value: "#2B2620" },
        ochre: { $value: "#A86E2E" },
      },
      theme: {
        paper: {
          ground: { $value: "#F5EAD4" },
          card: { $value: "#FFFDF8" },
          text: { $value: "{color.ink}" },
          accent: { $value: "{color.ochre}" },
        },
        ink: { ground: { $value: "#211D18" } },
      },
      font: {
        family: {
          serif: { $value: ["Fraunces", "Georgia", "serif"] },
          mono: { $value: ["Geist Mono", "ui-monospace", "monospace"] },
        },
        tracking: { display: { $value: -0.028 } },
        size: { display: { $value: "156px" } },
      },
      radius: { card: { $value: "18px" }, pill: { $value: "999px" } },
    });
    expect(odTokensFromTokenJson(dtcg)).toEqual({
      "--bg": "#F5EAD4",
      "--surface": "#FFFDF8",
      "--fg": "#2B2620",
      "--accent": "#A86E2E",
      "--font-display": "Fraunces, Georgia, serif",
      "--font-mono": '"Geist Mono", ui-monospace, monospace',
      "--tracking-display": "-0.028em",
      "--radius-pill": "999px",
    });
    // A token set fills --accent, so --accent-on is derived, not guessed.
    const p = od([], odTokensFromTokenJson(dtcg));
    expect(p.manifest.guessed).not.toContain("--accent-on");
    expect(p.manifest.guessed).toContain("--text-4xl");
  });

  it("takes only the approved token set, base mode first", () => {
    const set = (title: string, props: Record<string, unknown>) =>
      e("brand-token-set", title, props);
    const got = odTokensFromEntities([
      set("dark", {
        "token-mode": "dark",
        "token-json": '{"--text-xs":"1px"}',
      }),
      set("draft", {
        "token-status": "draft",
        "token-json": '{"--text-xs":"2px"}',
      }),
      set("base", {
        "token-mode": "base",
        "token-json": '{"--text-xs":"3px"}',
      }),
    ]);
    expect(got).toEqual({ "--text-xs": "3px" });
    expect(odTokensFromEntities([])).toBeUndefined();
  });
});

describe("od-design-system — hash and existing formats are unchanged", () => {
  const kit = brandKitFromEntities(FIXTURE);
  const base = exportBrandKit(kit, "json").hash;

  it("has the same hash as every other format, with or without a token set", () => {
    expect(exportBrandKit(kit, "od-design-system").hash).toBe(base);
    expect(
      exportBrandKit(kit, "od-design-system", {
        tokens: { "--text-xs": "9px" },
      }).hash
    ).toBe(base);
  });

  it("ignores token-set rows in the kit input", () => {
    const withSet = brandKitFromEntities([
      ...FIXTURE,
      e("brand-token-set", "T", { "token-json": '{"--text-xs":"9px"}' }),
    ]);
    expect(withSet).toEqual(kit);
    expect(exportBrandKit(withSet, "json").hash).toBe(base);
  });

  it("pins the json, css and frame-md hash on the fixture (value computed on origin/main before this change)", () => {
    const hashes = (["json", "css", "frame-md"] as const).map(
      (f) => exportBrandKit(kit, f).hash
    );
    expect(new Set(hashes)).toEqual(new Set([base]));
    expect(base).toBe(PINNED_HASH);
    expect(exportBrandKit(kit, "css").content).toContain(
      "--brand-primary: #d9a35b;"
    );
  });
});

const PINNED_HASH = "17e4143f0c0a23";
