/**
 * CROSS-REPO tripwire — CP publish gate ⟷ pod apply door.
 *
 * THE DEFECT THIS GUARDS
 * ======================
 * A package definition passes through TWO plain-`z.object` gates on its way
 * from an author to a provisioned workspace:
 *
 *   author → CP `packageDefinitionSchema` (POST /api/packages)   [registry]
 *          → pod `PackageApplySchema`     (POST /api/hub/packages/apply)
 *
 * zod v3 STRIPS unknown keys. The sibling CP test
 * (`synap-control-plane-api/src/routes/packages-definition-coverage.test.ts`)
 * guards the FIRST gate against its own `PackageDefinition` type — but nothing
 * guarded the SECOND. So a field CP deliberately widened its schema to carry
 * could still be deleted one hop later, and every downstream consumer
 * (preflight, `checkPermissionOrPropose`'s stored `definition`,
 * `materializeWorkspaceCore`, `applyPackagePostWorkspace`) received the already
 * thinned body. No error, no log.
 *
 * That is exactly how `relationDefs` was lost: CP added its slot *because*
 * stripping it "meant a republished workspace silently lost its relation graph"
 * — and the pod stripped it one layer further down, restoring the bug.
 *
 * BOTH KEY SETS ARE DERIVED, NEVER TYPED OUT
 * ==========================================
 * A hand-written key list would rot exactly like the thing it guards, so both
 * sides are extracted from SOURCE by the same brace-depth scanner. The two
 * schemas live in different repos and different pnpm workspaces, so neither can
 * `import` the other — reading the text is the only door. Precedent for a
 * backend test reading the sibling CP checkout:
 * `services/automations/config-automation-seeds.validate.test.ts`.
 *
 * A textual extraction that silently returns nothing would pass vacuously, so
 * the first two cases assert both sets are real and above a floor.
 *
 * WHY THIS TEST LIVES IN synap-backend
 * ====================================
 * The pod is the side that DROPS. `PackageApplySchema` is edited here, so the
 * guard has to fail in the repo where the regression is authored — a guard in
 * CP would go red in a repo whose diff is innocent. CP keeps its own type-level
 * guard for its own half; this one owns the seam between them.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// From packages/api/src/__tripwires__ up to the monorepo root (Code/synap).
const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const CP_PACKAGES_TS = join(
  REPO_ROOT,
  "synap-control-plane-api/src/routes/packages.ts"
);
const POD_PACKAGES_TS = join(
  import.meta.dirname,
  "../routers/hub-protocol/rest/packages.ts"
);

/**
 * Top-level keys of a `z.object({ … })` literal, read straight from source.
 *
 * Walks the object body character by character, tracking bracket depth and
 * skipping strings / template literals / comments, then collects `ident:` and
 * `"ident":` at depth 0 of the literal. Nested object keys (and anything inside
 * a comment or a string) are therefore invisible, which is what "top-level"
 * means here.
 */
function topLevelObjectKeys(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`declaration not found in source: ${declaration}`);
  }
  const open = source.indexOf("{", start + declaration.length - 1);
  if (open === -1) throw new Error(`no object literal after ${declaration}`);

  const keys: string[] = [];
  let depth = 0;
  let i = open;
  // Text of the literal at depth 1, with nested content / strings / comments
  // replaced by a space so the key regex below can never see into them.
  let flat = "";

  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    // Comments
    if (depth >= 1 && ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      flat += " ";
      continue;
    }
    if (depth >= 1 && ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      flat += " ";
      continue;
    }

    // Strings / template literals (no nested-interpolation support needed:
    // neither schema interpolates inside a key position).
    if (depth >= 1 && (ch === '"' || ch === "'" || ch === "`")) {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        j++;
      }
      // A quoted key at depth 1 is still a key — keep it, quotes and all.
      flat += depth === 1 ? source.slice(i, j + 1) : " ";
      i = j;
      continue;
    }

    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      if (depth === 1) continue; // the literal's own opening brace
      flat += " ";
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) break; // literal closed
      flat += " ";
      continue;
    }

    if (depth === 1) flat += ch;
  }

  if (depth !== 0) throw new Error(`unbalanced object literal: ${declaration}`);

  const KEY_RE = /(?:^|,)\s*(?:"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(flat)) !== null) {
    keys.push((m[1] ?? m[2]) as string);
  }
  return [...new Set(keys)].sort();
}

/**
 * Fields the CONTROL PLANE legitimately owns and the pod's apply door has no
 * business declaring. Every entry needs a reason: this list is the only escape
 * hatch, so an unexplained addition is how the guard would be defeated.
 */
const CP_ONLY: Record<string, string> = {
  // The body of a `category = "capability"` PACKAGE — not a workspace layer.
  // Installed through `market.install({kind:"capability"})`
  // (services/capabilities/marketplace-install.ts), never through
  // /api/hub/packages/apply, which provisions a WORKSPACE.
  capability:
    "capability-PACKAGE body; installed via market.install, not packages/apply",
  // Registry provenance for a definition generated from an npm package.
  // Describes the catalog row's origin; nothing on the pod reads it.
  sourcePackage: "CP registry provenance (npm origin of the definition)",
  // sha256 the CP mirrors into the package row's `version` column. The pod
  // receives the version through `_meta.version`, not through the definition.
  contentHash: "CP row-version derivation; pod reads _meta.version instead",
};

/**
 * The CP checkout is a HARD dependency of this guard, and its absence must fail
 * LOUDLY rather than quietly.
 *
 * Reading it unguarded at module scope means a missing sibling checkout throws
 * during COLLECTION — and a file that fails to collect runs ZERO tests, which
 * this repo has already been burned by: the suite reports a failure with no
 * test names and, in any runner configured to tolerate collection errors, the
 * parity guard simply stops existing. Guarding here turns that into one named,
 * self-explaining assertion below.
 */
const cpAvailable = existsSync(CP_PACKAGES_TS);

const cpKeys = cpAvailable
  ? topLevelObjectKeys(
      readFileSync(CP_PACKAGES_TS, "utf8"),
      "export const packageDefinitionSchema = z.object("
    )
  : [];
const podKeys = topLevelObjectKeys(
  readFileSync(POD_PACKAGES_TS, "utf8"),
  "const PackageApplySchema = z.object("
);

describe("CP packageDefinitionSchema ⟷ pod PackageApplySchema parity", () => {
  it("can see the control-plane checkout it compares against", () => {
    expect(
      cpAvailable,
      `Cannot find ${CP_PACKAGES_TS}. This tripwire compares the CP publish ` +
        `schema against the pod apply schema, so it needs synap-control-plane-api ` +
        `checked out BESIDE synap-backend. Clone it there — do not delete or ` +
        `skip this test, that is how the two schemas silently drifted before.`
    ).toBe(true);
  });

  it("is non-vacuous: both key sets were really extracted", () => {
    // A scanner that silently matched nothing would make every assertion below
    // trivially true. These floors are well under the real counts (38 / 40).
    expect(cpKeys.length, "CP schema keys not extracted").toBeGreaterThan(25);
    expect(podKeys.length, "pod schema keys not extracted").toBeGreaterThan(25);
  });

  it("extracts real, recognizable keys (not comment or string noise)", () => {
    // Anchor on fields whose loss is documented in both files' headers.
    for (const key of ["profiles", "relationDefs", "cells", "bentoViewName"]) {
      expect(cpKeys, `CP schema is missing "${key}"`).toContain(key);
    }
    for (const key of ["profiles", "playbooks", "actionPlacements"]) {
      expect(podKeys, `pod schema is missing "${key}"`).toContain(key);
    }
  });

  it("every CP-accepted field has a pod slot or an explicit CP-only reason", () => {
    const unslotted = cpKeys.filter(
      (k) => !podKeys.includes(k) && !(k in CP_ONLY)
    );
    expect(
      unslotted,
      "these fields pass the CP publish gate and are then SILENTLY STRIPPED by " +
        "the pod's /api/hub/packages/apply door — add a slot to " +
        "PackageApplySchema, or add the key to CP_ONLY with a reason"
    ).toEqual([]);
  });

  it("the CP-only allowlist has no stale entries", () => {
    // An entry that CP no longer declares, or that the pod HAS since slotted,
    // is dead weight that makes the list harder to trust.
    const stale = Object.keys(CP_ONLY).filter(
      (k) => !cpKeys.includes(k) || podKeys.includes(k)
    );
    expect(stale, "remove these from CP_ONLY").toEqual([]);
  });
});
