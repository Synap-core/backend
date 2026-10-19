/**
 * ONE "N+" formatter (`formatFloorCount`, lens/header.ts). A capped count
 * reads "100+", an exact one "100" — and every "N+" this package prints goes
 * through it, so the lens strip, the space intent line and the Home brief can
 * never disagree on how a floor reads.
 *
 * The scan below hunts the copy shape `${expr}+` followed by a backtick in
 * every non-test .ts file under src/. It cannot see a "+" built some other
 * way ("" + n + "+", String(n).concat("+")); it is a tripwire for the shape
 * that was copied three times, not proof that no other spelling exists.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatFloorCount, lensCountDoorText } from "./header.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPY = /\$\{[^}`]+\}\+`/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("formatFloorCount — the one N+ formatter", () => {
  it("an exact count is bare; a floor carries +", () => {
    expect(formatFloorCount(3)).toBe("3");
    expect(formatFloorCount(3, false)).toBe("3");
    expect(formatFloorCount(100, true)).toBe("100+");
    expect(formatFloorCount(0)).toBe("0");
  });

  it("the lens door text reads through it", () => {
    expect(lensCountDoorText("blocking", 100, true)).toBe("100+ need you");
    expect(lensCountDoorText("blocking", 1)).toBe("1 needs you");
    expect(lensCountDoorText("produced", 4)).toBe("4 delivered");
  });

  it("no other file in this package spells `${n}+` itself", () => {
    const files = sourceFiles(SRC);
    // Non-vacuity: the scan walks the real tree and can see the shape.
    expect(files.length).toBeGreaterThan(100);
    expect(COPY.test("x ? `${count}+` : y")).toBe(true);
    const hits = files
      .filter((f) => COPY.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual(["lens/header.ts"]);
  });
});
