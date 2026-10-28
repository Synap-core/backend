import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contrastRatio,
  heroUIColors,
  readTokens,
  type ThemeMode,
} from "../lib/ochre-theme";

/**
 * pod-admin wears the ochre token SSOT (decision 53e110df, 28 Oct 2026).
 *
 * pod-admin cannot import `@synap-core/design-tokens` (it lives in the backend
 * pnpm workspace), so it keeps a MIRROR of the SSOT stylesheet and derives its
 * HeroUI theme from it (`lib/ochre-theme.ts`). Three things can drift, and each
 * has a guard below:
 *   1. the mirror stops being the SSOT (someone edits one side);
 *   2. the theme stops being derived from the mirror (a hand palette returns);
 *   3. a derived pair stops being readable (a token swap that fails contrast).
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIRROR = join(APP_ROOT, "app/synap-tokens.css");
/** `synap-backend/apps/pod-admin` → the monorepo root that holds all repos. */
const SSOT = join(
  APP_ROOT,
  "../../../synap-app/packages/design-tokens/src/synap-tokens.css"
);

const mirror = readFileSync(MIRROR, "utf8");
const MODES: readonly ThemeMode[] = ["light", "dark"];

describe("the mirror is the SSOT", () => {
  const present = existsSync(SSOT);

  // The backend CI checks out no synap-app sibling for pod-admin's suite, so
  // this half runs where the sibling exists (the devbox be tree, a full
  // checkout). Guards 2 and 3 run everywhere.
  it.skipIf(!present)(
    "app/synap-tokens.css is byte-equal to design-tokens",
    () => {
      expect(
        mirror === readFileSync(SSOT, "utf8"),
        "app/synap-tokens.css drifted from synap-app packages/design-tokens/src/" +
          "synap-tokens.css. Copy the SSOT file over the mirror; never edit the mirror."
      ).toBe(true);
    }
  );
});

describe("the HeroUI theme is derived from the mirror", () => {
  it.each(MODES)("reads the %s tokens the theme needs", (mode) => {
    const tokens = readTokens(mirror, mode);
    // A parser that found nothing would make every check below compare
    // undefined with undefined.
    expect(Object.keys(tokens).length).toBeGreaterThan(100);
    for (const name of [
      "background",
      "paper",
      "color",
      "muted",
      "primary",
      "primary-button",
      "primary-button-text",
      "primary-ink",
      "success-ink",
      "warning-ink",
      "error-ink",
      "focus-ring",
    ]) {
      expect(tokens[name], `--synap-${name} (${mode})`).toBeTruthy();
    }
  });

  it("light and dark read different values (the light block was found)", () => {
    const light = readTokens(mirror, "light");
    const dark = readTokens(mirror, "dark");
    expect(light.background).not.toBe(dark.background);
    expect(light.color).not.toBe(dark.color);
  });

  it.each(MODES)("%s: the page, ink and fills ARE the tokens", (mode) => {
    const tokens = readTokens(mirror, mode);
    const colors = heroUIColors(tokens);
    expect(colors.background).toBe(tokens.background);
    expect(colors.foreground).toBe(tokens.color);
    expect(colors.content1).toBe(tokens.paper);
    expect(colors.default[500]).toBe(tokens.muted);
    expect(colors.primary[500]).toBe(tokens.primary);
    expect(colors.primary.foreground).toBe(tokens["primary-button-text"]);
    expect(colors.danger.DEFAULT).toBe(tokens["error-ink"]);
  });

  it("tailwind.config.ts writes no colour of its own", () => {
    const config = readFileSync(join(APP_ROOT, "tailwind.config.ts"), "utf8");
    expect(config).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(config).not.toMatch(/\brgba?\(/);
    expect(config).toContain('heroUIColors(readTokens(tokensCss, "light"))');
    expect(config).toContain('heroUIColors(readTokens(tokensCss, "dark"))');
    expect(config).toContain('"app/synap-tokens.css"');
  });

  it("the layout loads the mirror and the SSOT's body face", () => {
    const layout = readFileSync(join(APP_ROOT, "app/layout.tsx"), "utf8");
    expect(layout).toContain('import "./synap-tokens.css";');
    expect(layout).not.toMatch(/dm-sans/i);
    for (const weight of ["400", "500", "600"]) {
      expect(layout).toContain(`./fonts/geist-${weight}.woff2`);
      expect(
        existsSync(join(APP_ROOT, `app/fonts/geist-${weight}.woff2`))
      ).toBe(true);
    }
  });
});

describe("every derived pair stays readable", () => {
  it.each(MODES)("%s: text on each fill clears 4.5:1", (mode) => {
    const c = heroUIColors(readTokens(mirror, mode));
    for (const key of [
      "primary",
      "secondary",
      "success",
      "warning",
      "danger",
    ] as const) {
      expect(
        contrastRatio(c[key].foreground, c[key].DEFAULT),
        `${key}-foreground on ${key} (${mode})`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MODES)(
    "%s: status text clears 4.5:1 on the page and the card",
    (mode) => {
      const c = heroUIColors(readTokens(mirror, mode));
      for (const key of ["success", "warning", "danger"] as const) {
        for (const ground of ["background", "content1"] as const) {
          expect(
            contrastRatio(c[key].DEFAULT, c[ground]),
            `text-${key} on ${ground} (${mode})`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  );

  it.each(MODES)("%s: ink clears 4.5:1 on every content step", (mode) => {
    const c = heroUIColors(readTokens(mirror, mode));
    for (const ground of [
      "background",
      "content1",
      "content2",
      "content3",
      "content4",
    ] as const) {
      expect(
        contrastRatio(c.foreground, c[ground]),
        `foreground on ${ground} (${mode})`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
