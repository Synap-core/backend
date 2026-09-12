/**
 * TRIPWIRE — the backend label resolver is a MIRROR of the frontend SSOT, and a
 * mirror without a tripwire is a fork.
 *
 * ── Why a mirror at all ─────────────────────────────────────────────────────
 * The SSOT is `resolvePropertyLabel` in `@synap-core/property-renderer`
 * (synap-app). It is NOT a dependency of synap-backend and is not resolvable
 * from it (`require.resolve` → MODULE_NOT_FOUND, verified 2026-09-12), so
 * `@synap/database`'s `resolvePropertyLabel` (utils/property-presentation.ts)
 * mirrors it. This file imports the SSOT BY RELATIVE PATH — possible for a
 * test, not for shipped code — and runs both on the same inputs.
 *
 * History that makes this non-optional: the SSOT's own docblock records that
 * the seeds write `uiHints.label` while readers read `uiHints.displayName`, so
 * seeded properties rendered their slug. That was fixed for the human UI; the
 * agent-facing `/discover` never got the fix and emitted `displayName === slug`
 * for every property on the live pod until 2026-09-12. Measured in the seed:
 * 159 property defs, 159 with `uiHints.label`, 0 with `uiHints.displayName`.
 *
 * ── The one INTENTIONAL divergence, pinned so changing it is a decision ─────
 * Rung 3. With no authored label the SSOT HUMANIZES the slug ("dueDate" →
 * "Due date"); the backend returns the RAW slug. For an agent reading a schema
 * door the slug is the token it must WRITE — "Due date" is not a writable key.
 * Zero seeded defs reach rung 3 today (all 159 are labelled), so this only
 * affects custom/template properties with no label. If the product decides
 * the door should humanize, change the backend AND the assertion below.
 *
 * ── What this does NOT prove ────────────────────────────────────────────────
 * A convergence guard proves SAMENESS, never CORRECTNESS: two resolvers agreeing
 * on a wrong precedence pass. And if the SSOT file moves, `beforeAll` throws
 * and every test here fails — red, not skipped.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePropertyLabel as backendMirror } from "@synap/database";

import { SEEDED_DEFS } from "./_seed-property-defs.js";

type Def = { slug: string; uiHints?: { displayName?: string; label?: string } };

/**
 * Loaded by COMPUTED path on purpose. A static relative import makes this
 * package's `tsc -p` follow the file out of its rootDir (TS6059 / TS6307) —
 * the SSOT lives in another repo. The cast is the SSOT's own signature.
 */
const SSOT_FILE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "synap-app",
  "packages",
  "core",
  "property-renderer",
  "src",
  "utils",
  "fieldFormatters.ts"
);
let frontendSSOT: (def: Def) => string;
beforeAll(async () => {
  ({ resolvePropertyLabel: frontendSSOT } = (await import(
    pathToFileURL(SSOT_FILE).href
  )) as { resolvePropertyLabel: (def: Def) => string });
});

/**
 * Inputs where a WRONG precedence would disagree with the right one. A row that
 * cannot rule out any candidate rule is decoration, so each names what it catches.
 */
const DISCRIMINATING: Array<{ catches: string; def: Def }> = [
  {
    catches: "reading label before displayName",
    def: { slug: "a", uiHints: { displayName: "Shown", label: "Hidden" } },
  },
  {
    catches: "dropping the label rung (the shipped defect)",
    def: { slug: "ek_claim", uiHints: { label: "Claim" } },
  },
  {
    catches: "not trimming",
    def: { slug: "b", uiHints: { displayName: "  Padded  " } },
  },
  {
    catches: "treating a blank displayName as authored",
    def: { slug: "c", uiHints: { displayName: "   ", label: "Fallback" } },
  },
  {
    catches: "treating an empty displayName as authored",
    def: { slug: "d", uiHints: { displayName: "", label: "Fallback" } },
  },
  {
    catches: "mangling authored casing",
    def: { slug: "mrr", uiHints: { label: "MRR" } },
  },
];

describe("backend label mirror ⇄ frontend SSOT", () => {
  it("agree on every seeded property (derived from the seed, not hand-listed)", () => {
    const defs = SEEDED_DEFS.map((d) => ({
      slug: String(d.slug),
      uiHints: d.uiHints as Def["uiHints"],
    }));
    expect(defs.length).toBeGreaterThan(0);

    const drift = defs
      .filter((d) => backendMirror(d) !== frontendSSOT(d))
      .map(
        (d) =>
          `${d.slug}: backend "${backendMirror(d)}" vs SSOT "${frontendSSOT(d)}"`
      );
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it.each(DISCRIMINATING)(
    "agree on authored labels — catches $catches",
    ({ def }) => {
      expect(backendMirror(def)).toBe(frontendSSOT(def));
    }
  );

  it("0 seeded defs reach rung 3 — a seed that does must reopen the divergence decision", () => {
    // The rung-3 divergence below is acceptable ONLY because no seeded property
    // reaches it (measured 2026-09-12: 0 of 159). A seed that adds an unlabelled
    // property makes /discover show "dueDate" where the UI shows "Due date" —
    // decide then, deliberately; do not let it diverge by default.
    const reachRung3 = SEEDED_DEFS.filter((d) => {
      const h = (d.uiHints ?? {}) as Record<string, unknown>;
      const authored = (v: unknown) => typeof v === "string" && v.trim() !== "";
      return !authored(h.displayName) && !authored(h.label);
    }).map((d) => String(d.slug));
    expect(SEEDED_DEFS.length).toBeGreaterThan(0);
    expect(
      reachRung3,
      `These seeded properties have no authored label, so the backend mirror and ` +
        `the frontend SSOT now DISAGREE on them. Label them in the seed, or change ` +
        `the backend's rung 3 and the assertion below.`
    ).toEqual([]);
  });

  it("RUNG 3 DIVERGES ON PURPOSE: backend keeps the writable slug, SSOT humanizes", () => {
    const unlabelled: Def = { slug: "dueDate", uiHints: {} };
    expect(backendMirror(unlabelled)).toBe("dueDate");
    expect(frontendSSOT(unlabelled)).toBe("Due date");
  });
});
