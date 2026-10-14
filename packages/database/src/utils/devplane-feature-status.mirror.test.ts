/**
 * MIRROR PIN — `DEVPLANE_FEATURE_STATUS_KEYS` (what `ensureDevplaneProfiles`
 * declares and `devplane.seedSynapProjectData` writes) equals the
 * `featureStatus` lifecycle the catalog declares in builder.yaml, in order.
 *
 * The catalog is the source; this seeder once declared `planned | in-progress
 * | done | error`, keys no lifecycle knows (homes A5).
 *
 * What it does NOT cover: it reads the catalog from the sibling `synap-app`
 * checkout, so a backend-only checkout (CI) SKIPS it — a skip is reported,
 * never a pass. It parses the flow-style option lines (`- { key: …, … }`)
 * of the one lifecycle block, not YAML in general.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVPLANE_FEATURE_STATUS_KEYS } from "./ensure-system-profiles.js";

const BUILDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../synap-app/packages/workspace-templates/src/builder.yaml"
);

/** The option keys of the lifecycle block whose `property` is `prop`. */
export function lifecycleKeys(yaml: string, prop: string): string[] {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `property: ${prop}`);
  if (at === -1) return [];
  const keys: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "options:") continue;
    const m = line.match(/^\s*-\s*\{\s*key:\s*([\w-]+)\s*,/);
    if (!m) break; // the first line that is not an option ends the block
    keys.push(m[1]!);
  }
  return keys;
}

describe("devplane featureStatus keys mirror the catalog lifecycle", () => {
  it("the parser sees a literal sample (non-vacuity)", () => {
    expect(
      lifecycleKeys(
        "  lifecycle:\n    property: x\n    options:\n      - { key: a, category: open }\n      - { key: b-c, category: done }\n  other: 1\n",
        "x"
      )
    ).toEqual(["a", "b-c"]);
  });

  it.skipIf(!existsSync(BUILDER))(
    "equals builder.yaml's featureStatus options, in order",
    () => {
      const keys = lifecycleKeys(
        readFileSync(BUILDER, "utf8"),
        "featureStatus"
      );
      expect(keys.length).toBeGreaterThanOrEqual(4);
      expect(keys).toEqual([...DEVPLANE_FEATURE_STATUS_KEYS]);
    }
  );
});
