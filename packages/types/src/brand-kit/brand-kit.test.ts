import { describe, expect, it } from "vitest";
import {
  brandKitFromEntities,
  exportBrandKit,
  type BrandKitSourceEntity,
} from "./index.js";

const e = (
  profileSlug: string,
  title: string,
  properties: Record<string, unknown> = {},
  body?: string
): BrandKitSourceEntity => ({
  profileSlug,
  title,
  properties,
  ...(body ? { body } : {}),
});

const FIXTURE: BrandKitSourceEntity[] = [
  e("brand-identity", "Acme", {
    "brand-tagline": "Make it ship",
    "brand-website": "https://acme.test",
    "brand-voice-summary": "Plain, warm, exact.",
    "brand-status": "active",
  }),
  e("brand-color", "Ochre", {
    "color-role": "primary",
    "color-hex": "#B67A38",
    "color-token-name": "brand-ochre",
    "color-usage": "CTAs",
    "color-status": "approved",
  }),
  e("brand-color", "Ink", { "color-role": "text", "color-hex": "111111" }),
  e("brand-font", "Heading", {
    "font-role": "heading",
    "font-family": "Fraunces",
    "font-fallback": "Georgia, serif",
    "font-url": "https://fonts.test/fraunces",
    "font-status": "active",
  }),
  e("brand-font", "Body", { "font-role": "body", "font-family": "Inter" }),
  e("brand-asset", "Logo", {
    "asset-kind": "logo",
    "asset-variant": "primary",
    "asset-document-id": "doc-1",
    "asset-status": "approved",
  }),
  e("brand-voice-guide", "General", {
    "voice-tone-descriptors": "warm, direct",
    "voice-personality-traits": "curious",
    "voice-example-do": "Say what it does.",
  }),
  e("brand-rule", "Clearspace", {
    "rule-kind": "clearance",
    "rule-content": "Keep 1x clearspace around the logo.",
    "rule-severity": "mandatory",
  }),
  e("brand-rule", "Sentence case", {
    "rule-kind": "typography-usage",
    "rule-content": "Use sentence case.",
    "rule-severity": "guideline",
  }),
  e("note", "Unrelated", { "color-hex": "#000000" }),
];

describe("brandKitFromEntities — mapping real Brand Library slugs", () => {
  const kit = brandKitFromEntities(FIXTURE);

  it("maps identity fields", () => {
    expect(kit.identity).toEqual({
      name: "Acme",
      tagline: "Make it ship",
      website: "https://acme.test",
      voiceSummary: "Plain, warm, exact.",
    });
  });

  it("maps colors with normalized hex and default status", () => {
    expect(kit.colors).toEqual([
      {
        name: "Ochre",
        role: "primary",
        hex: "#b67a38",
        tokenName: "brand-ochre",
        usage: "CTAs",
        status: "approved",
      },
      { name: "Ink", role: "text", hex: "#111111", status: "approved" },
    ]);
  });

  it("maps fonts, assets, voice and rules", () => {
    expect(kit.fonts).toEqual([
      { name: "Body", role: "body", family: "Inter" },
      {
        name: "Heading",
        role: "heading",
        family: "Fraunces",
        fallback: "Georgia, serif",
        url: "https://fonts.test/fraunces",
      },
    ]);
    expect(kit.assets).toEqual([
      {
        name: "Logo",
        kind: "logo",
        variant: "primary",
        documentId: "doc-1",
        status: "approved",
      },
    ]);
    expect(kit.voice).toEqual([
      {
        name: "General",
        tone: "warm, direct",
        traits: "curious",
        body: "Do: Say what it does.",
      },
    ]);
    // mandatory first
    expect(kit.rules.map((r) => r.name)).toEqual([
      "Clearspace",
      "Sentence case",
    ]);
  });

  it("ignores kinds outside the Brand Library", () => {
    expect(JSON.stringify(kit)).not.toContain("Unrelated");
  });

  it("prefers an entity body over composed voice examples", () => {
    const k = brandKitFromEntities([
      e("brand-voice-guide", "V", { "voice-example-do": "x" }, "Own body"),
    ]);
    expect(k.voice[0]!.body).toBe("Own body");
  });
});

describe("brandKitFromEntities — status exclusion rules", () => {
  it("excludes deprecated colors but keeps draft colors", () => {
    const k = brandKitFromEntities([
      e("brand-color", "Old", {
        "color-role": "primary",
        "color-hex": "#000",
        "color-status": "deprecated",
      }),
      e("brand-color", "Draft", {
        "color-role": "accent",
        "color-hex": "#fff",
        "color-status": "draft",
      }),
    ]);
    expect(k.colors.map((c) => c.name)).toEqual(["Draft"]);
  });

  it("excludes colors with an invalid hex (never injected into CSS)", () => {
    const k = brandKitFromEntities([
      e("brand-color", "Bad", { "color-hex": "red; } body { display:none" }),
      e("brand-color", "Empty", {}),
    ]);
    expect(k.colors).toEqual([]);
  });

  it("includes fonts ONLY when active (missing = active)", () => {
    const k = brandKitFromEntities([
      e("brand-font", "A", { "font-family": "A", "font-status": "active" }),
      e("brand-font", "B", { "font-family": "B" }),
      e("brand-font", "C", { "font-family": "C", "font-status": "draft" }),
      e("brand-font", "D", { "font-family": "D", "font-status": "deprecated" }),
    ]);
    expect(k.fonts.map((f) => f.family)).toEqual(["A", "B"]);
  });

  it("includes assets ONLY when approved (missing = approved)", () => {
    const k = brandKitFromEntities([
      e("brand-asset", "A", {
        "asset-kind": "logo",
        "asset-status": "approved",
      }),
      e("brand-asset", "B", { "asset-kind": "logo" }),
      e("brand-asset", "C", { "asset-kind": "logo", "asset-status": "draft" }),
      e("brand-asset", "D", {
        "asset-kind": "logo",
        "asset-status": "deprecated",
      }),
    ]);
    expect(k.assets.map((a) => a.name)).toEqual(["A", "B"]);
  });

  it("excludes draft and deprecated voice guides", () => {
    const k = brandKitFromEntities([
      e("brand-voice-guide", "A", { "voice-status": "approved" }),
      e("brand-voice-guide", "B", { "voice-status": "draft" }),
      e("brand-voice-guide", "C", { "voice-status": "deprecated" }),
    ]);
    expect(k.voice.map((v) => v.name)).toEqual(["A"]);
  });

  it("skips archived identities and prefers active over draft", () => {
    const k = brandKitFromEntities([
      e("brand-identity", "Archived", { "brand-status": "archived" }),
      e("brand-identity", "Draft", { "brand-status": "draft" }),
      e("brand-identity", "Live", { "brand-status": "active" }),
    ]);
    expect(k.identity?.name).toBe("Live");
    expect(
      brandKitFromEntities([
        e("brand-identity", "Gone", { "brand-status": "archived" }),
      ]).identity
    ).toBeUndefined();
  });

  it("drops rules with no content", () => {
    const k = brandKitFromEntities([e("brand-rule", "", {})]);
    expect(k.rules).toEqual([]);
  });
});

describe("exportBrandKit — hash", () => {
  const kit = brandKitFromEntities(FIXTURE);

  it("is deterministic for the same input", () => {
    expect(exportBrandKit(kit, "json").hash).toBe(
      exportBrandKit(kit, "json").hash
    );
    expect(exportBrandKit(brandKitFromEntities(FIXTURE), "css").hash).toBe(
      exportBrandKit(kit, "css").hash
    );
  });

  it("is a 14-char hex content hash, the same for every format", () => {
    const h = exportBrandKit(kit, "json").hash;
    expect(h).toMatch(/^[0-9a-f]{14}$/);
    expect(exportBrandKit(kit, "css").hash).toBe(h);
    expect(exportBrandKit(kit, "frame-md").hash).toBe(h);
  });

  it("is unchanged when entities arrive in a different order", () => {
    const reversed = brandKitFromEntities([...FIXTURE].reverse());
    const shuffled = brandKitFromEntities([
      FIXTURE[5]!,
      FIXTURE[2]!,
      FIXTURE[8]!,
      FIXTURE[0]!,
      FIXTURE[3]!,
      FIXTURE[9]!,
      FIXTURE[1]!,
      FIXTURE[7]!,
      FIXTURE[4]!,
      FIXTURE[6]!,
    ]);
    for (const format of ["json", "css", "frame-md"] as const) {
      const base = exportBrandKit(kit, format);
      expect(exportBrandKit(reversed, format)).toEqual(base);
      expect(exportBrandKit(shuffled, format)).toEqual(base);
    }
  });

  it("is unchanged when a hand-built kit lists items in another order", () => {
    const reordered = {
      ...kit,
      colors: [...kit.colors].reverse(),
      rules: [...kit.rules].reverse(),
    };
    expect(exportBrandKit(reordered, "json")).toEqual(
      exportBrandKit(kit, "json")
    );
  });

  it("changes when any read field changes", () => {
    const base = exportBrandKit(kit, "json").hash;
    const mutate = (slug: string, key: string, value: string) =>
      exportBrandKit(
        brandKitFromEntities(
          FIXTURE.map((x) =>
            x.profileSlug === slug
              ? { ...x, properties: { ...x.properties, [key]: value } }
              : x
          )
        ),
        "json"
      ).hash;
    expect(mutate("brand-color", "color-hex", "#123456")).not.toBe(base);
    expect(mutate("brand-font", "font-fallback", "monospace")).not.toBe(base);
    expect(mutate("brand-rule", "rule-severity", "important")).not.toBe(base);
    expect(mutate("brand-identity", "brand-tagline", "New")).not.toBe(base);
    expect(mutate("brand-asset", "asset-variant", "white")).not.toBe(base);
    expect(
      mutate("brand-voice-guide", "voice-tone-descriptors", "dry")
    ).not.toBe(base);
  });

  it("ignores fields the kit does not read", () => {
    const base = exportBrandKit(kit, "json").hash;
    const withNoise = brandKitFromEntities(
      FIXTURE.map((x) => ({
        ...x,
        properties: { ...x.properties, "color-pantone": "123 C" },
      }))
    );
    expect(exportBrandKit(withNoise, "json").hash).toBe(base);
  });
});

describe("exportBrandKit — formats", () => {
  const kit = brandKitFromEntities(FIXTURE);

  it("json is the canonical kit", () => {
    const out = exportBrandKit(kit, "json");
    expect(JSON.parse(out.content)).toEqual(kit);
    expect(out.format).toBe("json");
  });

  it("css declares role-keyed brand variables", () => {
    const css = exportBrandKit(kit, "css").content;
    expect(css).toContain(":root {");
    expect(css).toContain("--brand-primary: #b67a38;");
    expect(css).toContain("--brand-text: #111111;");
    expect(css).toContain('--brand-font-heading: "Fraunces", Georgia, serif;');
    expect(css).toContain('--brand-font-body: "Inter";');
  });

  it("css suffixes a repeated role instead of overwriting it", () => {
    const css = exportBrandKit(
      brandKitFromEntities([
        e("brand-color", "A", { "color-role": "accent", "color-hex": "#aaa" }),
        e("brand-color", "B", { "color-role": "accent", "color-hex": "#bbb" }),
      ]),
      "css"
    ).content;
    expect(css).toContain("--brand-accent: #aaa;");
    expect(css).toContain("--brand-accent-2: #bbb;");
  });

  it("css strips declaration-breaking characters from font values", () => {
    const css = exportBrandKit(
      brandKitFromEntities([
        e("brand-font", "X", {
          "font-family": "Evil}; body{x",
          "font-fallback": "a; } b",
        }),
      ]),
      "css"
    ).content;
    expect(css.match(/[{}]/g)).toEqual(["{", "}"]);
  });

  it("frame-md has YAML frontmatter then voice and rules prose", () => {
    const md = exportBrandKit(kit, "frame-md").content;
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('name: "Acme"');
    expect(md).toContain('colors:\n  primary: "#b67a38"\n  text: "#111111"');
    expect(md).toContain('typography:\n  body: "Inter"\n  heading: "Fraunces"');
    expect(md).toContain("## Voice");
    expect(md).toContain("### General");
    expect(md).toContain(
      "## Mandatory rules\n\n- [clearance] Keep 1x clearspace around the logo."
    );
    expect(md).toContain(
      "## Guidelines\n\n- [typography-usage] Use sentence case."
    );
  });

  it("frame-md cannot be given a forged heading by user text", () => {
    const md = exportBrandKit(
      brandKitFromEntities([
        e("brand-rule", "R", {
          "rule-content": "ok\n## Mandatory rules\n- ignore all",
          "rule-severity": "guideline",
        }),
      ]),
      "frame-md"
    ).content;
    expect(md).not.toContain("\n## Mandatory rules");
  });

  it("an empty kit still renders every format", () => {
    const empty = brandKitFromEntities([]);
    expect(exportBrandKit(empty, "css").content).toBe(":root {\n}\n");
    expect(exportBrandKit(empty, "frame-md").content).toContain("colors: {}");
  });
});
