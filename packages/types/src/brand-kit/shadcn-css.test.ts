/**
 * `format=css-shadcn`: a project's brand (values for Synap's DTCG paths)
 * projected onto shadcn's variables, for a client app's kit (plan 0fc746f4
 * W6). Absent paths stay absent, aliases are followed (a shadcn app has no
 * `--synap-*`), modes split like synap-css.
 */
import { describe, expect, it } from "vitest";
import {
  BRAND_KIT_FORMATS,
  brandKitFromEntities,
  exportBrandKit,
} from "./index.js";
import { DTCG_TO_SHADCN, shadcnCssFromDtcg } from "./shadcn-css.js";
import { DTCG_TO_SYNAP } from "./synap-css.js";

const color = (hex: string, light?: string) => ({
  $type: "color",
  $value: { colorSpace: "srgb", components: [0, 0, 0], hex },
  ...(light
    ? {
        $extensions: {
          "com.synap.modes": {
            light: { colorSpace: "srgb", components: [1, 1, 1], hex: light },
          },
        },
      }
    : {}),
});

const CRM = {
  surface: {
    background: color("#101318", "#EEF0EA"),
    "background-surface": color("#181c23", "#ffffff"),
    "background-hover": color("#1d222a", "#f7f8f4"),
  },
  ink: { color: color("#e8ebf0", "#14181f") },
  brand: { primary: color("#8da2ff", "#2440c7") },
  border: {
    "border-color-focus": { $type: "color", $value: "{brand.primary}" },
  },
  radius: {
    $type: "dimension",
    "radius-control": { $value: { value: 10, unit: "px" } },
  },
};

describe("shadcnCssFromDtcg", () => {
  it("maps a brand's Synap paths to shadcn's names, by mode", () => {
    const d = shadcnCssFromDtcg(CRM);
    expect(d.light["--background"]).toBe("#eef0ea");
    expect(d.dark["--background"]).toBe("#101318");
    expect(d.light["--card"]).toBe("#ffffff");
    expect(d.light["--popover"]).toBe("#ffffff");
    expect(d.light["--foreground"]).toBe("#14181f");
    expect(d.light["--card-foreground"]).toBe("#14181f");
    // No primary-button: the brand's primary.
    expect(d.light["--primary"]).toBe("#2440c7");
    expect(d.light["--muted"]).toBe("#f7f8f4");
    expect(d.vars["--radius"]).toBe("10px");
  });

  it("follows an alias to its value: a shadcn app has no --synap-* to point at", () => {
    const d = shadcnCssFromDtcg(CRM);
    expect(d.dark["--ring"] ?? d.vars["--ring"]).toBe("#8da2ff");
    expect(JSON.stringify(d)).not.toMatch(/--synap-/);
  });

  it("leaves out what the brand does not set, so the app keeps its own value", () => {
    const d = shadcnCssFromDtcg(CRM);
    const all = { ...d.vars, ...d.light, ...d.dark };
    expect(all).not.toHaveProperty("--destructive");
    expect(all).not.toHaveProperty("--primary-foreground");
    expect(shadcnCssFromDtcg({ not: "dtcg" })).toEqual({
      vars: {},
      light: {},
      dark: {},
    });
  });

  it("reads only Synap's own paths (one naming rule, D1)", () => {
    const synapPaths = new Set(DTCG_TO_SYNAP.map(([p]) => p));
    for (const [, paths] of DTCG_TO_SHADCN)
      for (const p of paths) expect(synapPaths.has(p), p).toBe(true);
  });

  it("is a token format: hashed by the token set, the same hash as dtcg and synap-css", () => {
    expect(BRAND_KIT_FORMATS).toContain("css-shadcn");
    const shadcn = exportBrandKit(brandKitFromEntities([]), "css-shadcn", {
      dtcg: CRM,
    });
    const dtcg = exportBrandKit(brandKitFromEntities([]), "dtcg", {
      dtcg: CRM,
    });
    expect(shadcn.hash).toBe(dtcg.hash);
    expect(JSON.parse(shadcn.content)).toEqual(shadcnCssFromDtcg(CRM));
  });
});
