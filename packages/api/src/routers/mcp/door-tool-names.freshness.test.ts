/**
 * TRIPWIRE — `door-tool-names.generated.ts` is FRESH against the two door
 * manifests (pod MCP manifest, CP curated catalog).
 *
 * Compares the committed TABLE VALUE with a fresh build — not file bytes, which a
 * formatter reflows.
 *
 * The CP manifest is a SIBLING repo. Policy for a missing sibling
 * (memory: cross-repo-sameness-test-vs-standalone-ci):
 *   - present           → compare with a fresh build;
 *   - absent + CI       → skip, NAMED;
 *   - absent locally    → fail loudly (a local checkout is expected to have it).
 * The pinned builder tests below run everywhere.
 *
 * FIX WHEN RED:  cd packages/api && npx tsx src/routers/mcp/gen-door-tool-names.ts
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildDoorToolNames,
  parseCpCuratedPairs,
} from "./door-tool-names.build.js";
import { DOOR_TOOL_NAMES } from "./door-tool-names.generated.js";
import {
  DOOR_TOOL_NAME_PATHS,
  buildDoorToolNamesFromManifests,
} from "./gen-door-tool-names.js";

const missingSiblings = [DOOR_TOOL_NAME_PATHS.cpCurated].filter(
  (p) => !existsSync(p)
);
const skipInCi = missingSiblings.length > 0 && Boolean(process.env.CI);
if (skipInCi) {
  console.warn(
    `[door-tool-names.freshness] SKIPPED in CI: sibling manifest(s) not checked out: ${missingSiblings.join(", ")}`
  );
}

describe("tripwire: door tool-name table is generated, not maintained", () => {
  it.skipIf(skipInCi)(
    "committed table equals a fresh build from the sibling manifests",
    () => {
      expect(
        missingSiblings,
        "sibling repos must be checked out beside synap-backend"
      ).toEqual([]);
      expect(DOOR_TOOL_NAMES).toEqual(buildDoorToolNamesFromManifests());
    }
  );
});

describe("door tool-name builder (pinned, runs everywhere)", () => {
  const cpSource = `
    { name: "ask", podToolName: "synap_ask", description: "x" },
    { name: "define_kind",
      podToolName: "synap_define_kind" },`;

  it("maps each door's name, null where the CP connector does not curate it", () => {
    const table = buildDoorToolNames({
      podToolNames: ["synap_define_kind", "synap_ask", "synap_governance"],
      cpCuratedSource: cpSource,
    });
    expect(table).toEqual({
      synap_ask: { "pod-mcp": "synap_ask", "cp-connector": "pod__ask" },
      synap_define_kind: {
        "pod-mcp": "synap_define_kind",
        "cp-connector": "pod__define_kind",
      },
      synap_governance: { "pod-mcp": "synap_governance", "cp-connector": null },
    });
  });

  it("refuses a CP source whose podToolName entries it cannot pair", () => {
    expect(() =>
      parseCpCuratedPairs(
        `${cpSource}\n { podToolName: "synap_orient", name: "orient" }`
      )
    ).toThrow(/paired 2 of 3/);
  });
});
