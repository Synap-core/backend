/**
 * POD-CALLBACK TRIPWIRE
 *
 * Structural guarantee against the "wrong key / wrong URL" class — the defect
 * where the IS turn-dispatch payload's pod-callback credentials were hand-built
 * at 7 sites and drifted: 5 of 6 passed the reverse-direction webhook key
 * (`serviceApiKey`) as `dataPodApiKey` instead of the `is_internal` pod-read key,
 * so operator-floor delegation never fired and every agent read returned 0; and
 * `dataPodUrl` had three different fallback chains across the same sites.
 *
 * The fix centralized both fields into `getPodCallback()` (utils/pod-callback.ts),
 * spread into every turn payload as `...getPodCallback()`. This test forbids any
 * site from re-introducing a hand-written `dataPodUrl:` / `dataPodApiKey:` literal
 * — the only sanctioned producer is the helper itself.
 *
 * If this fails: you wrote `dataPodUrl:` or `dataPodApiKey:` directly. Don't —
 * spread `...getPodCallback()` instead. The single exception is the helper file
 * and this test.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Scan both the package src and the app src (channel-gateway lives in apps/api).
const PKG_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = [PKG_SRC, join(PKG_SRC, "..", "..", "..", "apps", "api", "src")];

// The ONLY files allowed to mention these fields literally.
const ALLOWLIST = new Set(["pod-callback.ts", "pod-callback.tripwire.test.ts"]);

// `dataPodApiKey:` or `dataPodUrl:` followed by anything other than the start of
// a `getPodCallback()` spread — i.e. a hand-assigned value.
const HANDWRITTEN = /\bdataPod(?:ApiKey|Url)\s*:/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("pod-callback tripwire", () => {
  it("no site hand-writes dataPodUrl/dataPodApiKey — all go through getPodCallback()", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const base = file.split("/").pop() ?? file;
        if (ALLOWLIST.has(base)) continue;
        const src = readFileSync(file, "utf8");
        src.split("\n").forEach((line, i) => {
          if (HANDWRITTEN.test(line)) {
            offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    }
    expect(
      offenders,
      `Hand-written pod-callback field(s) found — spread \`...getPodCallback()\` instead:\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });
});
