import { describe, it, expect } from "vitest";
import {
  SERVICE_MARKS,
  GENERIC_SERVICE_PATH,
  normalizeServiceId,
  resolveServiceMark,
  resolveServiceName,
  type ServiceMarkDef,
} from "./index.js";

const ENTRIES = Object.entries(SERVICE_MARKS) as Array<
  [string, ServiceMarkDef]
>;

// A single SVG path: starts with a moveto, contains only path-data characters.
const SVG_PATH = /^[Mm][MmZzLlHhVvCcSsQqTtAa0-9.,\s-]+$/;
const HEX = /^#[0-9A-F]{6}$/;

describe("service-marks registry", () => {
  it("is non-vacuous", () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(ENTRIES)(
    "%s has a name, a drawable mark and a colour",
    (_id, def) => {
      expect(def.name.trim()).not.toBe("");
      if (def.path !== null) expect(def.path).toMatch(SVG_PATH);
      // A colour is either the brand hex, or the declared ink (brand is black/white
      // or not a brand) — never neither.
      if (def.inkMark)
        expect(def.hex === undefined || HEX.test(def.hex)).toBe(true);
      else expect(def.hex).toMatch(HEX);
    }
  );

  it("every vendored mark is a brand mark (a withheld path never pretends to be one)", () => {
    const withMarks = ENTRIES.filter(([, d]) => d.path !== null);
    expect(withMarks.length).toBeGreaterThanOrEqual(10);
    for (const [, d] of withMarks)
      expect(d.path).not.toBe(GENERIC_SERVICE_PATH);
  });

  it("aliases are unique and never shadow a canonical id", () => {
    const ids = new Set(ENTRIES.map(([id]) => id));
    const seen = new Set<string>();
    for (const [, d] of ENTRIES) {
      for (const a of d.aliases ?? []) {
        expect(ids.has(a)).toBe(false);
        expect(seen.has(a)).toBe(false);
        seen.add(a);
      }
    }
  });
});

describe("resolveServiceMark", () => {
  it("resolves ids and aliases, case-insensitively", () => {
    expect(normalizeServiceId(" Telegram ")).toBe("telegram");
    expect(normalizeServiceId("google-mail")).toBe("gmail");
    expect(normalizeServiceId("twitter")).toBe("x");
    expect(resolveServiceMark("google-mail").name).toBe("Gmail");
  });

  it("colour variant paints the brand hex; mono paints the surrounding ink", () => {
    expect(resolveServiceMark("telegram", "color").fill).toBe("#26A5E4");
    expect(resolveServiceMark("telegram", "mono").fill).toBe("currentColor");
    expect(resolveServiceMark("telegram").path).toBe(
      SERVICE_MARKS.telegram.path
    );
  });

  it("an ink-mark brand stays in ink even in colour (a #000 mark would vanish on dark)", () => {
    expect(resolveServiceMark("github", "color").fill).toBe("currentColor");
  });

  it("an owner-withheld brand draws the neutral glyph tinted with its colour", () => {
    const slack = resolveServiceMark("slack", "color");
    expect(slack.known).toBe(true);
    expect(slack.name).toBe("Slack");
    expect(slack.path).toBe(GENERIC_SERVICE_PATH);
    expect(slack.fillRule).toBe("evenodd");
    expect(slack.fill).toBe("#4A154B");
  });

  it("an unknown id is humanized, never leaked raw, never a crash", () => {
    const m = resolveServiceMark("acme_crm");
    expect(m.known).toBe(false);
    expect(m.name).toBe("Acme crm");
    expect(m.path).toBe(GENERIC_SERVICE_PATH);
    expect(m.fill).toBe("currentColor");
    expect(resolveServiceMark(null).name).toBe("");
    expect(resolveServiceName("sms")).toBe("SMS");
  });
});
