/**
 * The request story's rail carries state (done solid, not yet dashed), so it
 * holds 3:1 against the card and the page, in both themes (WCAG 1.4.11; the
 * desktop kit's rail measured 1.20:1, finding 65c3ac38). Read from the CSS the
 * page ships (`app/globals.css`) and the token mirror, never a hand palette:
 * a `color-mix(… N%, transparent)` is blended over the ground it sits on.
 *
 * What it does not see: a rail colour set inline or by a class other than
 * `.rq-rail-*`, and the Now box's tint under the rail.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contrastRatio,
  heroUIColors,
  readTokens,
  type ThemeMode,
} from "../../../lib/ochre-theme";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const mirror = readFileSync(join(ROOT, "app/synap-tokens.css"), "utf8");

/** `{ token, alpha }` of a `.rq-rail-<name>` border colour, or null. */
function railColour(name: string): { token: string; alpha: number } | null {
  const block = css.match(
    new RegExp(`\\.rq-rail-${name}\\s*\\{([^}]*)\\}`)
  )?.[1];
  if (!block) return null;
  const mixed = block.match(
    /color-mix\(in srgb,\s*var\(--synap-([\w-]+)\)\s*(\d+)%,\s*transparent\)/
  );
  if (mixed) return { token: mixed[1]!, alpha: Number(mixed[2]) / 100 };
  const plain = block.match(/var\(--synap-([\w-]+)\)/);
  return plain ? { token: plain[1]!, alpha: 1 } : null;
}

const hex = (v: string) => {
  const m = v.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a 6-digit hex: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
};
const over = (fg: string, alpha: number, ground: string) => {
  const f = hex(fg);
  const g = hex(ground);
  return `#${f
    .map((c, i) =>
      Math.round(c * alpha + g[i]! * (1 - alpha))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
};

describe("the story rail holds 3:1 on its ground", () => {
  it("finds both rails (non-vacuity)", () => {
    expect(railColour("done")).not.toBeNull();
    expect(railColour("next")).not.toBeNull();
  });

  it.each(["light", "dark"] as ThemeMode[])("%s theme", (mode) => {
    const tokens = readTokens(mirror, mode);
    const colors = heroUIColors(tokens);
    for (const name of ["done", "next"]) {
      const { token, alpha } = railColour(name)!;
      const fg = tokens[token];
      expect(fg, `--synap-${token} (${mode})`).toBeTruthy();
      for (const ground of ["content1", "background"] as const) {
        const g = colors[ground];
        expect(
          contrastRatio(over(fg!, alpha, g), g),
          `rq-rail-${name} on ${ground} (${mode})`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
