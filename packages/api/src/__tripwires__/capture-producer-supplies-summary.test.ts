/**
 * TRIPWIRE — every producer that files a capture/import proposal must supply a
 * real `summary`; it may never rely on `submitCaptureGraph`'s count fallback.
 *
 * MEASURED (2961 live proposals): `summary` present on 39.8% of rows,
 * `reasoning` on 34.8%, `proposalProvenance.rawSource` on 0.2% — 6 rows. The
 * mechanism was never missing: `submitCaptureGraph` has always accepted a
 * `summary` and only falls back to `Proposed graph: N entities, M links` when a
 * caller omits one. So the reviewer's inbox described the SHAPE of the write
 * instead of what was asked for, and the highest-volume lane (Hub REST
 * `/capture/structure`) passed no summary at all while the user's own sentence
 * sat in `body.text` two lines above the call.
 *
 * Derived, not hand-listed: the producer set is discovered by scanning api/src
 * for `submitCaptureGraph({`, so a producer added tomorrow is caught here
 * rather than shipping with a count for a description. A size floor guards
 * against a broken extraction passing vacuously.
 *
 * ALSO GUARDED: the one truncation constant. `rawSource.rawText` was capped by
 * caller CONVENTION at three different values (100_000 / 8_000 / none) while
 * the field's own doc claimed the core enforced a bound. The core now does; a
 * producer re-introducing a literal slice is a fourth cap by another name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");
const REPO = join(here, "..", "..", "..");

const WHY_IT_MATTERS =
  "This producer calls submitCaptureGraph without ever passing `summary`, so " +
  "every proposal it files reaches the reviewer described as " +
  '"Proposed graph: N entities, M links" — the shape of the write, not what ' +
  "was asked for. Pass a narrative summary saying WHAT and FROM WHERE; " +
  "buildCaptureNarrativeSummary (services/capture-agent/capture-narrative.ts) " +
  "is the shared shape, and it returns undefined when the producer genuinely " +
  "knows neither, which is the ONLY case where the count fallback is correct.";

const WHY_ONE_BOUND =
  "This producer slices rawSource.rawText with its own literal. The bound is " +
  "RAW_SOURCE_MAX_CHARS, enforced by submitCaptureGraph itself " +
  "(capture-narrative.ts) — a caller-side literal is how 100_000 / 8_000 / " +
  "none came to coexist behind a doc claiming one bound existed.";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules" || name === "__tripwires__")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

const CALL = "submitCaptureGraph({";

/**
 * Strip comments before scanning. `map-booking-to-graph.ts` DOCUMENTS its output
 * as "plugs straight into `submitCaptureGraph({ entities, relations })`" — a
 * prose mention, not a producer. Counting it would report a file that files no
 * proposal at all, and a tripwire that cries wolf gets suppressed.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Files that FILE a capture graph — the set that must describe what it filed. */
function captureProducers(): string[] {
  return walk(API_SRC).filter(
    (f) =>
      stripComments(readFileSync(f, "utf8")).includes(CALL) &&
      // The door itself is the fallback's owner, not a producer of it.
      !f.endsWith(join("capture-agent", "submit-capture-graph.ts"))
  );
}

/**
 * The argument object of the `submitCaptureGraph({ … })` at `idx`, brace-matched
 * so a `summary:` belonging to some LATER call in the same file cannot satisfy
 * an earlier producer. Whole-file matching is the vacuity this avoids:
 * `hub-protocol/rest/capture.ts` holds TWO producers, and for a long time only
 * the second passed a summary.
 */
function callArgs(src: string, idx: number): string {
  const start = idx + CALL.length - 1; // at the '{'
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

function eachCall(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf(CALL);
  while (at !== -1) {
    out.push(callArgs(src, at));
    at = src.indexOf(CALL, at + CALL.length);
  }
  return out;
}

describe("tripwire: every capture producer supplies a narrative summary", () => {
  const producers = captureProducers();

  it("finds the known producers (extraction is not vacuous)", () => {
    const rel = producers.map((f) => relative(REPO, f));
    expect(
      producers.length,
      `expected the known capture producers, found: ${rel.join(", ")}`
    ).toBeGreaterThanOrEqual(5);
    for (const expected of [
      "services/event-sync/run-gcal-import.ts",
      "services/calcom/run-cal-backfill.ts",
      "services/capabilities/builtin-verbs.ts",
      "routers/webhooks-inbound.ts",
      "routers/mcp/handlers/capture.ts",
      "routers/hub-protocol/rest/capture.ts",
    ]) {
      expect(
        rel.some((f) => f.endsWith(expected)),
        `known producer ${expected} not discovered — the scan broke`
      ).toBe(true);
    }
  });

  it("each submitCaptureGraph call passes a summary", () => {
    const offenders: string[] = [];
    for (const file of producers) {
      const src = stripComments(readFileSync(file, "utf8"));
      eachCall(src).forEach((args, n) => {
        if (!/(^|[\s,{])summary\s*:/m.test(args)) {
          offenders.push(`${relative(REPO, file)} (call #${n + 1})`);
        }
      });
    }
    expect(offenders, `${offenders.join("; ")} — ${WHY_IT_MATTERS}`).toEqual(
      []
    );
  });

  it("no producer slices rawSource.rawText with its own literal", () => {
    const offenders: string[] = [];
    for (const file of producers) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const args of eachCall(src)) {
        const at = args.indexOf("rawText:");
        if (at === -1) continue;
        const line = args.slice(at, args.indexOf("\n", at));
        if (/\.slice\(\s*0\s*,\s*[\d_]+/.test(line)) {
          offenders.push(`${relative(REPO, file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `${offenders.join("; ")} — ${WHY_ONE_BOUND}`).toEqual([]);
  });

  it("the core enforces the bound its type doc promises", () => {
    const src = readFileSync(
      join(API_SRC, "services", "capture-agent", "submit-capture-graph.ts"),
      "utf8"
    );
    const at = src.indexOf("proposalProvenance:");
    expect(at, "proposalProvenance block not found").toBeGreaterThan(-1);
    expect(
      src.slice(at, at + 900),
      "submitCaptureGraph must pass rawSource.rawText through boundRawSourceText — " +
        "otherwise the field's doc asserts a bound nothing applies, which is the " +
        "defect that let three caller-side caps coexist."
    ).toContain("boundRawSourceText(");
  });

  it("both proposal-data terminals persist the duplicate advisory", () => {
    // submitCaptureGraph has TWO terminals — auto-applied and pending — each
    // building its own `data: { … }`. `pendingDuplicateCandidates` used to
    // reach only the RETURN value, so the proposal row kept no record that the
    // write was already suspected of duplicating an in-flight one. Duplication
    // IS this proposal type's blast radius (166 live composite proposals: only
    // create_entity + create_relation, zero destructive), so a terminal that
    // drops it files the risk signal nowhere. Both must spread it, or they
    // drift and one lane silently loses the field.
    const src = readFileSync(
      join(API_SRC, "services", "capture-agent", "submit-capture-graph.ts"),
      "utf8"
    );
    const spreads = src.match(/\.\.\.duplicateAdvisory,/g) ?? [];
    expect(
      spreads.length,
      "both the auto-applied and the pending `data` block must spread " +
        "`duplicateAdvisory` — a terminal that omits it files a proposal whose " +
        "row carries no duplicate warning, which is the field's whole purpose."
    ).toBe(2);
    // ABSENT must not be confused with "checked, found none": an empty array is
    // a claim the best-effort scan (which swallows lookup failures) cannot make.
    expect(
      src,
      "duplicateAdvisory must be `{}` when there are no candidates, never an empty array"
    ).toMatch(
      /pendingDuplicateCandidates\.length > 0\s*\?[\s\S]{0,80}pendingDuplicateCandidates:/
    );
  });

  it("RAW_SOURCE_MAX_CHARS is the only bound literal", () => {
    const narrative = readFileSync(
      join(API_SRC, "services", "capture-agent", "capture-narrative.ts"),
      "utf8"
    );
    expect(narrative).toMatch(/export const RAW_SOURCE_MAX_CHARS = 100_000;/);
    // The Hub REST codec must REJECT at exactly what the core would CLIP at.
    const codec = readFileSync(
      join(API_SRC, "routers", "hub-protocol", "rest", "_codecs", "misc.ts"),
      "utf8"
    );
    expect(
      codec,
      "CaptureGraphRawSourceSchema must bound rawText by RAW_SOURCE_MAX_CHARS, not a literal"
    ).toContain("z.string().max(RAW_SOURCE_MAX_CHARS)");
  });
});
