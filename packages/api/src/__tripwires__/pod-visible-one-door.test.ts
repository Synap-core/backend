/**
 * TRIPWIRE — "pod-visible" has ONE door (Sites W2 S2, the guest floor).
 *
 * A workspace whose `settings.workspaceVisibility` is `pod_visible` /
 * `pod_joinable` is readable by every pod READER — never by a guest, never by an
 * unknown principal. That gate lives in exactly one place:
 * `podVisibleWorkspaceWhere(userId)` (@synap/database utils/user-visible-where.ts).
 * Every hand-spelled `settings->>'workspaceVisibility' IN (...)` predicate was a
 * floor that skipped the gate: nine of them existed before this wave, and each
 * one handed a guest the whole pod-visible corpus.
 *
 * The scanned set is DERIVED: every non-test `.ts` file under every
 * `packages/<pkg>/src`, so a new package or file joins the scan by existing.
 * A site may keep the literal only with a `JUSTIFIED KEEP` comment within the
 * 8 lines above it, stating why no caller-scoped floor applies.
 *
 * What it does NOT see: a predicate spelled another way (a JS check on the
 * settings object such as `isPodReadableWorkspace`, or a different SQL
 * spelling). Those were reviewed by hand in the W2-S2 report; the remaining JS
 * uses are write-side materialisations, not read floors.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const DOOR = path.join("database", "src", "utils", "user-visible-where.ts");
const LITERAL = /workspaceVisibility'\s*IN\s*\(/;
const KEEP = /JUSTIFIED KEEP/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
}

function scan(): { files: string[]; offenders: string[]; doorHits: number } {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src, files);
    } catch {
      // a package without src/ has nothing to scan
    }
  }
  const offenders: string[] = [];
  let doorHits = 0;
  for (const file of files) {
    const rel = path.relative(PACKAGES, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!LITERAL.test(line)) return;
      if (rel === DOOR) {
        doorHits++;
        return;
      }
      const above = lines.slice(Math.max(0, i - 8), i).join("\n");
      if (!KEEP.test(above)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  return { files, offenders, doorHits };
}

describe("pod-visible has one door", () => {
  const { files, offenders, doorHits } = scan();

  it("the scan is not vacuous: it walks every package and can see the literal", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.includes(`${path.sep}jobs${path.sep}src`))).toBe(
      true
    );
    expect(
      files.some((f) => f.includes(`${path.sep}search${path.sep}src`))
    ).toBe(true);
    // The door itself spells the literal exactly once.
    expect(doorHits).toBe(1);
    expect(
      LITERAL.test(
        "drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`"
      )
    ).toBe(true);
  });

  it("no other file spells the pod-visible predicate without a JUSTIFIED KEEP", () => {
    expect(offenders).toEqual([]);
  });
});
