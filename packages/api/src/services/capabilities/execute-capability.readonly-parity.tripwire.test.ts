import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

import {
  capabilityVerbHasExternalEffect,
  verbDeclaresReadOnly,
} from "./execute-capability.js";
import {
  SKILL_METADATA_READ_ONLY,
  declaredReadOnly,
} from "./capability-drift.js";

/**
 * TRIPWIRE — the AUTHORED read-only declaration has ONE reader, not two.
 *
 * "This verb changes nothing" is consumed twice in `execute-capability.ts`:
 *
 *   1. the GOVERNANCE gate — `readOnly` passed to `gateCapabilityExecution`,
 *      which short-circuits the grant/propose ladder; and
 *   2. the AT-MOST-ONCE router — `capabilityVerbHasExternalEffect`, which
 *      decides whether the run goes through `runDirectWriteVerbOnce`.
 *
 * They were TWO expressions and they DID drift: the gate was taught to honour
 * `metadata.readOnly`, the router kept classifying by `skill.kind` + HTTP
 * method. `exa_search` (kind:"code") therefore auto-ran (right) and was then
 * receipt-deduped as an external send (wrong) — the receipt's DERIVED
 * content-hash key is WINDOWED at ~10 minutes, so a second identical search
 * replayed the first's stored result instead of searching the web again.
 *
 * This file pins the fix two ways, because either alone is defeatable:
 *   Part A (behavioural) — the declaration wins over kind AND method, on the
 *     rows where the old rule and the new rule DISAGREE.
 *   Part B (source, comment-stripped) — `declaredReadOnly(` has exactly ONE
 *     call site in the file, so a future site cannot re-derive its own answer.
 */

type Row = Parameters<typeof capabilityVerbHasExternalEffect>[0];

const row = (
  kind: string | null,
  providerSpec: unknown,
  metadata: Record<string, unknown> | null
): Row =>
  ({
    kind,
    name: "exa_search",
    providerSpec,
    metadata,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

// ── Part A: behavioural — the DISCRIMINATING rows ─────────────────────────────

describe("declared readOnly beats kind + method at the at-most-once router", () => {
  /**
   * Each row is one where the PRE-FIX rule (kind/method only) and the POST-FIX
   * rule (declaration first) give DIFFERENT answers — that is what makes the
   * row load-bearing rather than decorative. A row where both rules agree
   * cannot rule the wrong rule out, so it belongs in Part A's control list
   * below, not here.
   */
  const discriminating: Array<[string, Row]> = [
    // THE live bug: exa_search is kind:"code" → old rule's fail-closed `true`.
    ["code + declared readOnly", row("code", null, { readOnly: true })],
    // An HTTP POST that is a search: the provider path's /^(GET|HEAD)$/ test
    // called it a write.
    [
      "declarative POST + declared readOnly",
      row("declarative", { method: "POST" }, { readOnly: true }),
    ],
    // GraphQL: a POST whose operation was omitted → old rule fail-closed write.
    [
      "graphql (no operation) + declared readOnly",
      row(
        "declarative",
        { method: "POST", transport: "graphql", graphql: { query: "{x}" } },
        { readOnly: true }
      ),
    ],
    [
      "instruction + declared readOnly",
      row("instruction", null, { readOnly: true }),
    ],
    ["unknown kind + declared readOnly", row(null, null, { readOnly: true })],
  ];

  for (const [label, r] of discriminating) {
    it(`${label} → NO external effect (no receipt, no windowed replay)`, () => {
      expect(verbDeclaresReadOnly(r)).toBe(true);
      expect(capabilityVerbHasExternalEffect(r)).toBe(false);
    });
  }

  it("the declaration is the ONLY thing that moved: undeclared rows are unchanged", () => {
    // Controls. These must keep the pre-fix answer, or the fix has widened the
    // ungoverned/unreceipted path — the failure mode that actually matters.
    for (const md of [
      null,
      {},
      { readOnly: false },
      // Non-boolean is NOT coerced (see `declaredReadOnly`): a string "true"
      // must not buy an auto path.
      { readOnly: "true" },
      { readOnly: 1 },
    ] as Array<Record<string, unknown> | null>) {
      expect(verbDeclaresReadOnly(row("code", null, md))).toBe(false);
      expect(capabilityVerbHasExternalEffect(row("code", null, md))).toBe(true);
      expect(
        capabilityVerbHasExternalEffect(
          row("declarative", { method: "POST" }, md)
        )
      ).toBe(true);
      expect(
        capabilityVerbHasExternalEffect(
          row("declarative", { method: "GET" }, md)
        )
      ).toBe(false);
      expect(capabilityVerbHasExternalEffect(row("builtin", null, md))).toBe(
        false
      );
    }
  });

  it("the router and the gate read the SAME field, not two lookalike keys", () => {
    // Reachability, not shape: the value the gate's helper reads is the value
    // the drift-comparator's authored declaration writes, under the one key.
    const md = { [SKILL_METADATA_READ_ONLY]: true };
    expect(declaredReadOnly(md)).toBe(true);
    expect(verbDeclaresReadOnly(row("code", null, md))).toBe(true);
    expect(capabilityVerbHasExternalEffect(row("code", null, md))).toBe(false);
  });
});

// ── Part B: source — one reader of the declaration, two consumers of it ───────

describe("guard: `declaredReadOnly(` has exactly ONE call site in the door", () => {
  const raw = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "execute-capability.ts"),
    "utf8"
  );
  // Comments must be stripped: this file DOCUMENTS the rule in prose, and a
  // scan that counts prose trips on its own docblock (a named gotcha here).
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the scan is not vacuous — it can still see the code it hunts", () => {
    expect(raw.length).toBeGreaterThan(20_000);
    // Self-check: the two things counted below are visible AFTER stripping.
    expect(src).toContain("export function verbDeclaresReadOnly");
    expect(src).toContain("verbDeclaresReadOnly(skillRow)");
    // And the stripper really removed prose (the docblocks name the symbol).
    expect(raw.split("declaredReadOnly(").length - 1).toBeGreaterThan(
      src.split("declaredReadOnly(").length - 1
    );
  });

  it("exactly one expression reads the raw declaration", () => {
    // `verbDeclaresReadOnly` calls also contain the substring "DeclaresReadOnly("
    // but not "declaredReadOnly(" (capital D) — count the lowercase form only.
    const calls = src.match(/(?<![A-Za-z])declaredReadOnly\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("BOTH consumers go through the shared helper", () => {
    // 1 declaration + the gate + the at-most-once router = 3 occurrences.
    const uses = src.match(/verbDeclaresReadOnly\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/const readOnly =[\s\S]{0,200}verbDeclaresReadOnly\(/);
    expect(src).toMatch(
      /export function capabilityVerbHasExternalEffect\([\s\S]{0,400}verbDeclaresReadOnly\(/
    );
  });
});

/**
 * WHAT THIS DOES NOT COVER, measured.
 *
 * - Granularity of Part B is the FILE, not the call site: a THIRD consumer added
 *   inside `execute-capability.ts` that re-implements the check with an inline
 *   `metadata?.readOnly === true` (spelling neither symbol) is invisible to both
 *   scans. Verified by adding such a line and watching the suite stay green.
 * - Part B cannot see a consumer in ANOTHER file. `declaredReadOnly` is exported
 *   from `capability-drift.ts`; only this door's copies are counted.
 * - Nothing here exercises `gateCapabilityExecution` itself — Part A proves the
 *   two PURE classifiers agree and Part B proves the gate's `readOnly` is fed by
 *   the same helper; it does not prove the gate then honours `readOnly` (that is
 *   `policy.test.ts`'s job).
 */
