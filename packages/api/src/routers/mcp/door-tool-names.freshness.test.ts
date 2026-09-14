/**
 * TRIPWIRE — `door-tool-names.generated.ts` is FRESH against the three door
 * manifests (pod MCP manifest, CP curated catalog, Raycast catalog).
 *
 * Compares the committed TABLE VALUE with a fresh build — not file bytes, which a
 * formatter reflows.
 *
 * The CP and Raycast manifests are SIBLING repos. Policy for a missing sibling
 * (memory: cross-repo-sameness-test-vs-standalone-ci):
 *   - present           → compare with a fresh build;
 *   - absent + CI       → skip, NAMED: synap-backend CI checks out the CP repo but
 *                         not synap-raycast, so this cannot run there today;
 *   - absent locally    → fail loudly (a local checkout is expected to have both).
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

const missingSiblings = [
  DOOR_TOOL_NAME_PATHS.cpCurated,
  DOOR_TOOL_NAME_PATHS.raycastCatalog,
].filter((p) => !existsSync(p));
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

  it("maps each door's name, with covering Raycast tools and nulls for gaps", () => {
    const table = buildDoorToolNames({
      podToolNames: [
        "synap_define_kind",
        "synap_ask",
        "synap_get_graph",
        "synap_governance",
      ],
      cpCuratedSource: cpSource,
      raycastCatalog: {
        allowlist: [{ podToolName: "synap_define_kind", name: "define-kind" }],
        extras: ["get-connections"],
        gaps: {
          synap_get_graph: "COVERED — extra get-connections; later wave.",
          synap_governance: "FIRST-PARTY — owner action.",
        },
      },
    });
    expect(table).toEqual({
      synap_ask: {
        "pod-mcp": "synap_ask",
        "cp-connector": "pod__ask",
        raycast: null,
      },
      synap_define_kind: {
        "pod-mcp": "synap_define_kind",
        "cp-connector": "pod__define_kind",
        raycast: "define-kind",
      },
      synap_get_graph: {
        "pod-mcp": "synap_get_graph",
        "cp-connector": null,
        raycast: "get-connections",
      },
      synap_governance: {
        "pod-mcp": "synap_governance",
        "cp-connector": null,
        raycast: null,
      },
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
