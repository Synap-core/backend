/**
 * TRIPWIRE — every NON-FATAL install-layer catch in `definition-engine.ts` must
 * report an `InstallLayerReport`.
 *
 * WHY A SOURCE SCAN. The defect this guards is an ABSENCE: a catch that logs and
 * returns a clean payload. No behavioural test can see it, because the mutation
 * still resolves and still returns a well-formed report — that is exactly the
 * property that made three separate swallows survive in this one file. The only
 * thing that distinguishes "handled" from "swallowed" is what the catch BODY
 * does, so the catch body is what we assert on.
 *
 * The rule: for every install-layer call (`applyPackagePostWorkspace`, and the
 * layer-1 `reconcileWorkspaceFromDefinition` inside `reconcileExisting`), its
 * catch must either THROW (fatal — honest by construction) or push a layer entry
 * (non-fatal — honest by report). Logging alone is not honesty.
 *
 * NO ALLOWLIST, deliberately. An exemption list in a guard is shaped exactly
 * like the bug the guard exists to catch: the next swallow gets added to it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "definition-engine.ts"),
  "utf8"
);

/** Body of the brace-matched block starting at the `{` at or after `from`. */
function blockAfter(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

/** Every index at which `needle` occurs. */
function indicesOf(src: string, needle: string): number[] {
  const out: number[] = [];
  let i = src.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = src.indexOf(needle, i + needle.length);
  }
  return out;
}

/** The catch body guarding the call at `callIdx`, or null if the call is untried. */
function catchBodyFor(callIdx: number): string | null {
  const catchIdx = SOURCE.indexOf("} catch (", callIdx);
  if (catchIdx === -1) return null;
  return blockAfter(SOURCE, SOURCE.indexOf(")", catchIdx));
}

/** Honest = rethrows, or records a layer verdict (directly or via the summarizer). */
function isHonest(body: string): boolean {
  return (
    /\bthrow\b/.test(body) ||
    /\w*[Ll]ayers\.push\(/.test(body) ||
    /summarizePostWorkspaceLayers\(/.test(body)
  );
}

describe("definition-engine install-layer honesty", () => {
  // `await <call>({` subsumes the assigned forms (`const post = await …`), so
  // each call site is counted exactly once regardless of how its result is used.
  const applySites = indicesOf(SOURCE, "await applyPackagePostWorkspace({");
  const reconcileSites = indicesOf(
    SOURCE,
    "await reconcileWorkspaceFromDefinition({"
  );
  const callSites = [...applySites, ...reconcileSites];

  it("finds every install-layer call site (guards against the scan silently matching nothing)", () => {
    // A source-scan tripwire whose pattern stops matching passes vacuously —
    // the failure mode that made an earlier tripwire in this repo scan 0 fields.
    // Pin the denominator per call, so a scan that stops matching cannot pass
    // vacuously. Update these numbers ONLY together with a real new call site.
    expect(applySites).toHaveLength(4);
    expect(reconcileSites.length).toBeGreaterThanOrEqual(2);
  });

  it.each([...new Set(callSites)].sort((a, b) => a - b))(
    "the catch guarding the install-layer call at offset %i throws or reports a layer",
    (idx) => {
      const body = catchBodyFor(idx);
      // An untried call propagates naturally — that is fatal, and honest.
      if (body === null) return;
      expect(
        isHonest(body),
        `The catch guarding the install-layer call at offset ${idx} neither throws nor records an InstallLayerReport. ` +
          `A layer that fails silently is reported to the caller as a clean install. ` +
          `Catch body:\n${body.slice(0, 400)}`
      ).toBe(true);
    }
  );

  it("both reconcileExisting call sites forward the layers they collected", () => {
    // The helper returning `{report, layers}` is only half the fix: a call site
    // that destructures `report` and drops `layers` re-buries the failure.
    const sites = indicesOf(
      SOURCE,
      "await reconcileExisting(ws.id, wsSettings)"
    );
    expect(sites).toHaveLength(2);
    for (const idx of sites) {
      const window = SOURCE.slice(idx, idx + 1400);
      expect(
        window.includes("reconcileOutcome?.layers"),
        `A reconcileExisting call site at offset ${idx} does not read back its layers.`
      ).toBe(true);
      // Assert the PROPERTY (the layers reach the returned object), not one
      // spelling of it. This originally pinned the literal
      // `...(layers.length > 0 ? { layers } : {})`, and that spread had to be
      // replaced: a spread is not a fresh object literal, so it defeated
      // TypeScript's `prop?: undefined` normalization across the returned
      // union and made the sibling `composed` field unreadable by every
      // consumer — a cross-repo break no per-repo gate could see. A tripwire
      // that pins a FORM blocks the fix for the defect it was guarding.
      expect(
        /layers:\s*layers\.length > 0 \? layers : undefined/.test(window),
        `A reconcileExisting call site at offset ${idx} does not return its layers under a uniform \`layers\` key.`
      ).toBe(true);
      expect(
        window.includes("...(layers.length > 0 ? { layers } : {})"),
        `A reconcileExisting call site at offset ${idx} reintroduced the conditional spread — it widens the return union and breaks consumers.`
      ).toBe(false);
    }
  });
});
