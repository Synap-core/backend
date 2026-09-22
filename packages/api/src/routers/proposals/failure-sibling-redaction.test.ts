/**
 * The failed-state SIBLING writers must not park raw error text on `data`.
 *
 * Two halves, because neither alone is worth much:
 *
 *  1. BEHAVIOURAL — drive each writer's real redaction call with a bearer-token
 *     error body and assert the token is gone from what would be stored. This
 *     is what actually proves the fix; a source scan cannot.
 *  2. DERIVED COVERAGE — parse the writers' OWN `.set({ … data: { … } })` out
 *     of source and assert every top-level key they park beside `failure` is
 *     CLASSIFIED in `failure-projection.ts`. A third writer, or a third key on
 *     an existing writer, joins the scan by existing; it does not have to be
 *     remembered.
 *
 * What this does NOT cover, measured: the scan's granularity is the KEY, not
 * the expression assigned to it. A writer that added a fourth already-classified
 * key and assigned it raw text would pass (2) — which is why (1) drives the
 * real redactor and why both writers route their whole payload through one
 * `redactDeepForStorage` call rather than per-field ones.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  redactDeepForStorage,
  redactForStorage,
} from "../../utils/redact-secrets.js";
import {
  REDACTED_AT_WRITE_SIBLINGS,
  STRIPPED_SIBLINGS,
  projectProposalDataForViewer,
} from "./failure-projection.js";
import { classifyThrownFailure } from "./failure-classification.js";
import { runMaterializationUnderReceipt } from "../../services/proposals/stamp-materialized.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** A provider body that echoes the header that produced it — the real shape. */
const LEAKY =
  'Upstream 401 {"error":"invalid_token"} — request headers: ' +
  "Authorization: Bearer sk-live-AbCdEf0123456789XYZ, retry after 30s";
const TOKEN = "sk-live-AbCdEf0123456789XYZ";

/** Every string reachable in a JSON-ish value. Used for the deep assertions. */
function allStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const v of value) allStrings(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) allStrings(v, out, depth + 1);
  }
  return out;
}

describe("failed-state sibling writers — redaction at write", () => {
  it("non-vacuity: the sample body really does contain the token", () => {
    expect(LEAKY).toContain(TOKEN);
    expect(LEAKY).toMatch(/Bearer\s+sk-live/);
  });

  it("materializationError — driven through the REAL writer", async () => {
    // `runMaterializationUnderReceipt` takes its `db` as a parameter, so the
    // actual writer runs here: nothing about the stored payload is hand-built
    // downstream of the line under test. Deleting the `redactForStorage(…)`
    // call in stamp-materialized.ts turns this red.
    const sets: Array<Record<string, unknown>> = [];
    const fakeDb = {
      update: () => ({
        set: (v: Record<string, unknown>) => {
          sets.push(v);
          return { where: async () => undefined };
        },
      }),
    } as unknown as Parameters<typeof runMaterializationUnderReceipt>[2];

    await expect(
      runMaterializationUnderReceipt(
        { id: "receipt-1", data: { kind: "capture" } },
        async () => {
          throw new Error(LEAKY);
        },
        fakeDb
      )
    ).rejects.toThrow();

    expect(sets).toHaveLength(1); // non-vacuity: the writer really ran
    const written = sets[0];
    expect(written.status).toBeTruthy();
    const data = written.data as Record<string, unknown>;
    expect(typeof data.materializationError).toBe("string");
    expect(data.materializationError as string).not.toContain(TOKEN);
    // Still explains the failure — redaction narrows, it does not blank.
    expect(data.materializationError as string).toContain("401");
    // And nothing else on the written row carries it either.
    for (const s of allStrings(written)) expect(s).not.toContain(TOKEN);
  });

  it("planFailure.steps[].reason and compensation reasons are redacted at write", () => {
    const steps = [
      { op: "create_entity", ref: "e1", opIndex: 0, reason: LEAKY },
      { op: "link", ref: null, opIndex: 1, reason: "ok" },
    ];
    const compensation = {
      notCompensated: [{ kind: "entity", id: "abc", reason: LEAKY }],
    };
    const storedSteps = redactDeepForStorage(steps);
    const storedComp = redactDeepForStorage(compensation);
    for (const s of [...allStrings(storedSteps), ...allStrings(storedComp)]) {
      expect(s).not.toContain(TOKEN);
    }
    // Non-vacuity: the scan actually walked into the nested reasons.
    expect(allStrings(storedSteps).length).toBeGreaterThanOrEqual(5);
    expect(allStrings(storedSteps).some((s) => s.includes("401"))).toBe(true);
  });

  it("the USER-FACING projection of a failed row carries no token ANYWHERE", () => {
    const err = new Error(LEAKY);
    const meta = classifyThrownFailure(err);
    // The whole failed-row `data` as the two writers build it today.
    const data = {
      kind: "capability",
      materializationError: redactForStorage(err.message),
      failure: {
        errorClass: meta.errorClass,
        ...(meta.detail ? { detail: meta.detail } : {}),
      },
      planFailure: {
        at: "2026-09-21T00:00:00.000Z",
        by: "u1",
        steps: redactDeepForStorage([
          { op: "create_entity", opIndex: 0, reason: LEAKY },
        ]),
        compensation: redactDeepForStorage({
          notCompensated: [{ kind: "entity", id: "x", reason: LEAKY }],
        }),
      },
    };
    // Sanity: the AGENT-ONLY detail existed before projection.
    expect(data.failure.detail).toBeTruthy();
    const projected = projectProposalDataForViewer(data);
    const strings = allStrings(projected);
    expect(strings.length).toBeGreaterThan(5); // non-vacuity
    for (const s of strings) expect(s).not.toContain(TOKEN);
    expect(JSON.stringify(projected)).not.toContain(TOKEN);
  });
});

/**
 * Derive the sibling key set from the writers themselves.
 *
 * ## The file set is DERIVED, not listed (round-2 review)
 *
 * It used to be a two-entry array. A hand list on a coverage guard is the
 * defect this repo keeps re-shipping: it holds exactly the members that were
 * already correct when someone typed it, and a THIRD writer — a new failed
 * state parked beside `failure` in some other module — would have joined
 * NOTHING and left the guard green over an unclassified, unredacted key.
 *
 * So the set is now globbed: every non-test source under `routers/proposals/**`
 * and `services/proposals/**` whose own text contains a data literal with a
 * `failure` key. A new writer joins the scan BY EXISTING. The two known
 * writers are asserted to be in the derived set (the self-check), and the
 * literal count is floored, so a walker that goes blind — a renamed directory,
 * a tokenizer that stops seeing braces — fails loudly instead of passing over
 * an empty set.
 *
 * What this does NOT cover, measured: a writer OUTSIDE those two directories,
 * and a writer that builds the payload from a spread whose keys are not
 * literal in this file. Both would be invisible here.
 */
const SCANNED_DIRS = [
  { root: `${HERE}`, label: "routers/proposals" },
  { root: `${HERE}../../services/proposals/`, label: "services/proposals" },
] as const;

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      out.push(...sourceFilesUnder(`${full}/`));
      continue;
    }
    if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
    if (/\.(test|tripwire|seam|pglite)\./.test(e.name)) continue;
    out.push(full);
  }
  return out;
}

/** Every source file that BUILDS a `data` payload carrying a `failure` key. */
const WRITERS: ReadonlyArray<{ path: string; label: string; n: number }> =
  SCANNED_DIRS.flatMap(({ root, label }) =>
    sourceFilesUnder(root)
      .map((path) => ({
        path,
        label: `${label}/${path.slice(root.length)}`,
        n: failureDataLiterals(readFileSync(path, "utf8")).length,
      }))
      .filter((f) => f.n > 0)
  );

/**
 * Every object literal in `src` whose OWN top level declares a `failure` key —
 * i.e. the failed-state `data` payloads, wherever they are written and whether
 * they are inlined in the `.set({…})` or hoisted into a `const` first (one of
 * the three writers does the latter, which is exactly why this is not an
 * "indexOf('data: {')" scan: that one would have been invisible).
 *
 * Single forward pass with a stack of key-lists; string- and comment-blind
 * enough for the shapes here, and the caller asserts how many literals it found
 * so a tokenizer that goes blind fails loudly instead of silently.
 */
function failureDataLiterals(src: string): string[][] {
  const found: string[][] = [];
  const stack: string[][] = [];
  let quote: string | null = null;
  let inLine = false;
  let inBlock = false;
  /** Previous SIGNIFICANT character — whitespace and comments do not count. */
  let last = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && src[i + 1] === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") {
      stack.push([]);
      last = c;
      continue;
    }
    if (c === "}") {
      const keys = stack.pop();
      if (keys && keys.includes("failure")) found.push(keys);
      last = c;
      continue;
    }
    if (stack.length > 0 && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(src.slice(i, i + 80));
      // A property key sits right after `{` or `,`. Without this check a
      // TERNARY (`err instanceof Error ? err.message : String(err)`) reads as
      // a key named `message` — observed while writing this, which is why
      // `last` tracks the previous SIGNIFICANT character (comments skipped).
      if (m && (last === "{" || last === ",")) {
        stack[stack.length - 1].push(m[1]);
        i += m[0].length - 1;
        last = ":";
        continue;
      }
      // Skip the rest of this identifier so `failureFoo` can't be read as a
      // key start on its second character.
      while (i + 1 < src.length && /[A-Za-z0-9_$]/.test(src[i + 1])) i++;
      last = "x";
      continue;
    }
    if (!/\s/.test(c)) last = c;
  }
  return found;
}

describe("failed-state sibling writers — derived coverage", () => {
  const CLASSIFIED = new Set<string>([
    ...REDACTED_AT_WRITE_SIBLINGS,
    ...STRIPPED_SIBLINGS,
    // `failure` is the block the projection floor already owns.
    "failure",
  ]);

  it("the DERIVED set really found the writers — it is not an empty glob", () => {
    // Self-check on the derivation: the two writers this file was written for
    // must be IN the globbed set. If a rename or a moved directory empties the
    // walk, this fails instead of vacuously classifying nothing.
    const paths = WRITERS.map((w) => w.path);
    expect(paths.some((p) => p.endsWith("apply-approval.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("stamp-materialized.ts"))).toBe(true);
    expect(WRITERS.length).toBeGreaterThanOrEqual(2);
    // Non-vacuity with a number: three failed-state writes exist today
    // (apply-approval has TWO — the composite-plan one and `onApprovalFailed`).
    expect(WRITERS.reduce((a, w) => a + w.n, 0)).toBeGreaterThanOrEqual(3);
    // …and the walk itself saw a plausible number of FILES, so a filter that
    // rejects everything cannot pass as "no writers found".
    expect(
      SCANNED_DIRS.reduce((a, d) => a + sourceFilesUnder(d.root).length, 0)
    ).toBeGreaterThan(10);
  });

  it("every sibling key the writers park beside `failure` is CLASSIFIED", () => {
    const seen = new Set<string>();
    for (const w of WRITERS) {
      for (const keys of failureDataLiterals(readFileSync(w.path, "utf8"))) {
        for (const k of keys) seen.add(k);
      }
    }
    expect(WRITERS.length).toBeGreaterThanOrEqual(2); // non-vacuity
    // Self-check: the scan can still see the two keys this test was written
    // for. If a rename makes these vanish, the scan has gone blind.
    expect(seen).toContain("materializationError");
    expect(seen).toContain("planFailure");
    const unclassified = [...seen].filter((k) => !CLASSIFIED.has(k));
    expect(
      unclassified,
      "Unclassified failed-state sibling key(s). Add them to ProposalFailureSiblings in failure-projection.ts AND redact them at write."
    ).toEqual([]);
  });
});
