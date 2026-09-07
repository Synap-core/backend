/**
 * CROSS-REPO tripwire — every pod renderer SLOT is publishable from the CP.
 *
 * THE DEFECT THIS GUARDS
 * ======================
 * A cell package declares which renderer slot it fills as `cells[].contentKind`.
 * That value is spelled in FOUR places across two repos: the pod's SSOT
 * (`CONTENT_KINDS` / `SLOT_TO_CONTENT_KIND`), the CP's runtime publish gate
 * (`routes/packages.ts`), the CP's stored-definition TYPE
 * (`db/schema/packages.ts`) and the CP's marketplace cell projection
 * (`routes/marketplace-apps.ts`). Any one of them missing a value makes that
 * renderer unshippable as a package — a 400 at publish, or a field a client
 * cannot legally set.
 *
 * It has drifted twice already, and the second time was caused by the fix for
 * the first: `entity-card` was added to the CP's zod enum on 2026-09-05, while
 * the two TYPE unions one file over kept advertising four members. The existing
 * CP-side parity test reads only `routes/packages.ts`, so it stayed green.
 *
 * WHY THIS TEST LIVES IN synap-backend
 * ====================================
 * The pod OWNS the vocabulary. A value added here is the event that can strand
 * the CP, so the guard has to go red in the repo where the widening is authored.
 * CP keeps its own enum-vs-`CONTENT_KINDS` test for its own half; this one owns
 * the direction the CP cannot see.
 *
 * NEITHER SIDE IS HAND-TYPED. The pod side is a real import of the runtime
 * constants; the CP side is extracted from its source text (separate repos,
 * separate pnpm workspaces — no import is possible). A textual extraction that
 * silently returned nothing would pass vacuously, so every extractor asserts a
 * non-empty result. When the sibling repo is not checked out the comparisons
 * SKIP: a missing checkout is not a drift, and a false red trains people to
 * ignore the guard.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_KINDS } from "@synap/database/schema";
import { SLOT_TO_CONTENT_KIND } from "../services/profiles/renderer-slots.js";

// From packages/api/src/__tripwires__ up to the monorepo root (Code/synap).
const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const CP_ROUTE = join(
  REPO_ROOT,
  "synap-control-plane-api/src/routes/packages.ts"
);
const CP_TYPE = join(
  REPO_ROOT,
  "synap-control-plane-api/src/db/schema/packages.ts"
);
const CP_PROJECTION = join(
  REPO_ROOT,
  "synap-control-plane-api/src/routes/marketplace-apps.ts"
);

/** Every content kind the pod's four renderer slots resolve to. */
const POD_SLOT_KINDS = [...new Set(Object.values(SLOT_TO_CONTENT_KIND))];

/**
 * The string literals of the CP's `contentKind:` declaration in one file —
 * whether it is written as a `z.enum([...])` or as a TS union. Both forms are
 * a run of double-quoted literals terminated by the next `;` or `)`.
 */
function cpContentKinds(file: string): string[] {
  const src = readFileSync(file, "utf8");
  // Strip comments first: this repo documents the drift IN a comment that names
  // the very literals we are counting, which would otherwise be read as members.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const m = code.match(/contentKind\??:\s*([\s\S]*?)(?:;|\)\s*\.optional\(\))/);
  if (!m) {
    throw new Error(
      `no \`contentKind\` declaration found in ${file} — did it move or get renamed?`
    );
  }
  const kinds = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (kinds.length === 0) {
    throw new Error(
      `the \`contentKind\` declaration in ${file} yielded no literals — the extractor is broken, not the code.`
    );
  }
  return kinds;
}

const CP_FILES: Array<[label: string, path: string]> = [
  ["publish gate (routes/packages.ts)", CP_ROUTE],
  ["stored-definition type (db/schema/packages.ts)", CP_TYPE],
  ["marketplace projection (routes/marketplace-apps.ts)", CP_PROJECTION],
];

const haveCp = CP_FILES.every(([, p]) => existsSync(p));

describe("tripwire: every pod renderer slot is publishable from the CP", () => {
  it("the pod's own slot kinds are real and a subset of CONTENT_KINDS", () => {
    // Guards against a vacuous pass on the side that is imported rather than parsed.
    expect(POD_SLOT_KINDS.length).toBeGreaterThan(0);
    for (const kind of POD_SLOT_KINDS) {
      expect(
        CONTENT_KINDS as readonly string[],
        `\`${kind}\` is a renderer slot's content kind but not a member of CONTENT_KINDS.`
      ).toContain(kind);
    }
  });

  it.skipIf(!haveCp).each(CP_FILES)(
    "CP %s carries every pod slot content kind",
    (label: string, path: string) => {
      const cp = cpContentKinds(path);
      const missing = POD_SLOT_KINDS.filter((k) => !cp.includes(k));
      expect(
        missing,
        `The CP's ${label} is missing ${missing.join(", ")}.\n` +
          `  pod slots: ${POD_SLOT_KINDS.join(", ")}\n` +
          `  CP       : ${cp.join(", ")}\n` +
          `A slot the pod has and the CP lacks means a renderer for that slot ` +
          `CANNOT be shipped as a package — a 400 at publish, or a field the ` +
          `client cannot legally set. Widen the declaration in that CP file.`
      ).toEqual([]);
    }
  );

  it.skipIf(!haveCp).each(CP_FILES)(
    "CP %s declares nothing the pod does not know",
    (label: string, path: string) => {
      const unknown = cpContentKinds(path).filter(
        (k) => !(CONTENT_KINDS as readonly string[]).includes(k)
      );
      expect(
        unknown,
        `The CP's ${label} accepts ${unknown.join(", ")}, which the pod's ` +
          `CONTENT_KINDS does not contain — a package could publish a value the ` +
          `pod's apply door rejects.`
      ).toEqual([]);
    }
  );
});
