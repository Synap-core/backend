/**
 * TRIPWIRE (per-file ratchet) — a failed fetch or hub call never becomes empty.
 *
 * The rule (`rules/start-here`, "An EMPTY result and a FAILED read are
 * different facts"; plan 87ebac54 §5, decisions F10-F12): a `.catch` or
 * `catch {}` whose only outcome is an empty value or nothing (silent OR
 * logged) turns a failed read into a calm, wrong answer. The detector is the
 * ONE module `./failure-empty-detector.mjs` (+ `.d.mts`), a byte-for-byte
 * copy of synap-app's `packages/design-tokens/scripts/failure-empty-detector.mjs`.
 * Edit it there, copy it here; never edit this copy (the mirror test below
 * fails on any difference).
 *
 * BACKEND SCOPE (founder default, R3 §4: "Backend DB reads stay out of the
 * first guard scope"): of the detector's sites, this ratchet counts only those
 * whose guarded code (the try block, or the receiver of `.catch`) calls
 * `fetch(` (also `x.fetch(`, `podFetch(`) or a hub (`hub.`, `hubClient.`,
 * `hubFetch(`). `db.` reads, tRPC and other clients are out, for now.
 *
 * Shape (the same as synap-app's `check:failure-empty`, browser's and relay's
 * tripwires): a JSON baseline of per-file ceilings
 * (`failure-empty-baseline.json`, keys relative to the backend root, taken
 * 2026-11-05 at main 58a7edc9, no site cleaned up). A file rising above its
 * ceiling, or a new file with a site, is RED. A site that is right to end
 * empty says why on the line above: `// empty-ok: <reason>`; an empty reason
 * is RED. To lock in an improvement:
 * `FAILURE_EMPTY_UPDATE=1 npx vitest run scripts/failure-empty.tripwire.test.ts`
 * (lowers ceilings only; it never raises one or admits a new file).
 *
 * Roots: `apps/` and `packages/`. The detector's walker skips tests, stories,
 * fixtures, `__tripwires__`, any `scripts` folder (so `packages/scripts`),
 * declarations and build folders.
 *
 * DOES NOT SEE: `db.` reads and every non-fetch, non-hub client (scope above),
 * `?? []` on a read, a catch that SETS an empty state, a non-empty default, a
 * swallow behind a helper or a named handler other than `noop`, a `.catch` on
 * a value derived from a fetch (`res.json().catch(() => null)`), whether a
 * reason is true, or a file that swaps WHICH sites swallow at a flat count.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  SELF_CHECK,
  countFailureEmpty,
  findFailureEmptySites,
  listSourceFiles,
} from "./failure-empty-detector.mjs";
import {
  siblingCheckout,
  siblingRequired,
  siblingSkipReason,
} from "./sibling-checkout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..");
const ROOTS = [join(REPO, "apps"), join(REPO, "packages")];
const BASELINE = join(here, "failure-empty-baseline.json");
const MIRRORED = [
  "failure-empty-detector.mjs",
  "failure-empty-detector.d.mts",
] as const;

const keyOf = (abs: string) => relative(REPO, abs).split(sep).join("/");

type Baseline = { generated: string; files: Record<string, number> };

/** The backend scope: a `fetch(` call (any receiver or prefix) or a hub call. */
const IN_SCOPE_RE =
  /\bfetch\s*\(|\.fetch\s*\(|[a-z]Fetch\s*\(|\bhub\w*\s*[.(]/i;

/**
 * The guarded code of every `.catch(fn)` and `try/catch` in a file, keyed the
 * way the detector reports a site (its kind and its `catch` line), so the
 * scope is decided on the same text the detector's parse filter read.
 */
function guardedByLine(fileName: string, text: string): Map<string, string[]> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (pos: number) =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = new Map<string, string[]>();
  const add = (key: string, guarded: ts.Node) =>
    out.set(key, [...(out.get(key) ?? []), guarded.getText(sf)]);
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "catch" &&
      n.arguments.length === 1
    )
      add(
        `catch-call:${lineOf(n.expression.name.getStart(sf))}`,
        n.expression.expression
      );
    if (ts.isTryStatement(n) && n.catchClause)
      add(`try-catch:${lineOf(n.catchClause.getStart(sf))}`, n.tryBlock);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Unjustified in-scope sites per file, and every empty `// empty-ok:`. A site
 * is in scope when the guarded code of ANY handler of its kind on its line
 * calls fetch or a hub (two on one line: the stricter reading).
 */
function scanBackend(files: string[]) {
  const counts = new Map<string, number>();
  const emptyReasons: string[] = [];
  let total = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const { sites, emptyReasons: er } = findFailureEmptySites(f, text);
    for (const l of er) emptyReasons.push(`${f}:${l}`);
    const open = sites.filter((s) => !s.justified);
    if (open.length === 0) continue;
    const guarded = guardedByLine(f, text);
    const n = open.filter((s) =>
      (guarded.get(`${s.kind}:${s.line}`) ?? []).some((g) =>
        IN_SCOPE_RE.test(g)
      )
    ).length;
    if (n > 0) counts.set(f, n);
    total += n;
  }
  return { counts, emptyReasons, total };
}

/**
 * ONE named real site the scan must keep seeing (stronger than "≥1 site
 * anywhere"): `IntelligenceHubClient`'s structure call answers `null` when
 * its `fetch` to `/api/structure` fails. When it is fixed, pin another.
 */
const KNOWN_POSITIVE =
  "packages/intelligence-client/src/intelligence-hub-client.ts";

/**
 * The baseline `FAILURE_EMPTY_UPDATE=1` writes: each ceiling drops to its
 * current count and NEVER rises; a file not in the baseline never enters.
 */
function lowerBaseline(
  current: Map<string, number>,
  base: Record<string, number>
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, ceiling] of Object.entries(base)) {
    const cur = current.get(join(REPO, k)) ?? 0;
    if (cur > 0) next[k] = Math.min(cur, ceiling);
  }
  return Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b))
  );
}

/** Files above their ceiling (a missing key is a ceiling of 0). */
function rises(
  current: Map<string, number>,
  base: Record<string, number>
): string[] {
  const out: string[] = [];
  for (const [file, n] of current) {
    const k = keyOf(file);
    if (n > (base[k] ?? 0))
      out.push(`${k}: baseline=${base[k] ?? 0} current=${n}`);
  }
  return out.sort();
}

describe("a failed fetch or hub call never becomes empty (per-file ratchet over apps/ and packages/)", () => {
  const files = listSourceFiles(ROOTS);
  const { counts, emptyReasons, total } = scanBackend(files);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;

  it("scans a plausible number of files and finds real sites (non-vacuity)", () => {
    // 3,228 files and 41 in-scope sites in 32 files on 2026-11-05 (main 58a7edc9).
    expect(files.length).toBeGreaterThan(2500);
    expect(total).toBeGreaterThanOrEqual(30);
    expect(Object.keys(baseline.files).length).toBeGreaterThan(20);
    expect(files.map(keyOf)).toEqual(
      expect.arrayContaining([
        "apps/api/src/index.ts",
        "packages/api/src/index.ts",
        KNOWN_POSITIVE,
      ])
    );
  });

  it(`still sees the pinned real site in ${KNOWN_POSITIVE} (non-vacuity)`, () => {
    const abs = join(REPO, KNOWN_POSITIVE);
    expect(
      existsSync(abs),
      `pinned positive ${KNOWN_POSITIVE} is gone: pin another real site`
    ).toBe(true);
    expect(counts.get(abs) ?? 0).toBeGreaterThan(0);
    const text = readFileSync(abs, "utf8");
    const guarded = guardedByLine(abs, text);
    expect(
      findFailureEmptySites(abs, text).sites.some(
        (s) =>
          !s.justified &&
          s.kind === "try-catch" &&
          (guarded.get(`try-catch:${s.line}`) ?? []).some((g) =>
            g.includes("/api/structure")
          )
      ),
      "the structure call's `catch { return null; }` is no longer counted"
    ).toBe(true);
  });

  for (const c of SELF_CHECK) {
    it(`self-check shape: ${c.shape}`, () => {
      expect(countFailureEmpty("self-check.tsx", c.src)).toBe(c.n);
    });
  }

  it("self-check of the backend scope: fetch and hub sites count, db and other clients do not", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-empty-scope-"));
    try {
      const src = [
        "export async function a() { try { return await fetch(u); } catch { return null; } }",
        "export const b = () => hub.list().catch(() => []);",
        "export const c = () => this.podFetch(u).catch(() => {});",
        "export async function d() { try { return await db.query.x.findMany(); } catch { return []; } }",
        "export const e = () => trpc.list.query().catch(() => []);",
        "export const f = () => client.get(u).catch(() => null);",
      ].join("\n");
      writeFileSync(join(dir, "scope.ts"), src);
      const scanned = scanBackend(listSourceFiles([dir]));
      expect(
        countFailureEmpty("scope.ts", src),
        "the detector itself sees all six"
      ).toBe(6);
      expect(
        scanned.total,
        "the backend scope keeps the fetch and hub three"
      ).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every `// empty-ok:` gives a reason", () => {
    expect(
      emptyReasons.map(keyOf),
      "Say why the empty outcome is right, or handle the failure"
    ).toEqual([]);
  });

  it("no file rose above its baseline ceiling", () => {
    if (process.env.FAILURE_EMPTY_UPDATE === "1") {
      writeFileSync(
        BASELINE,
        JSON.stringify(
          {
            generated: new Date().toISOString().slice(0, 10),
            files: lowerBaseline(counts, baseline.files),
          },
          null,
          2
        ) + "\n"
      );
    }
    expect(
      rises(counts, baseline.files),
      "This ratchet only tightens: handle the failure, or justify the site with `// empty-ok: <reason>`. Never hand-raise the baseline"
    ).toEqual([]);
  });

  it("the update never raises a ceiling or admits a new file, and the rise stays red", () => {
    const [victim] = Object.entries(baseline.files).sort(
      (a, b) => b[1] - a[1]
    )[0]!;
    const victimCount = counts.get(join(REPO, victim)) ?? 0;
    expect(
      victimCount,
      "victim must carry >1 site for this test to mean anything"
    ).toBeGreaterThan(1);
    const base = { ...baseline.files, [victim]: 1 };
    const fresh = join(REPO, "packages/new-file.ts");
    const current = new Map([...counts, [fresh, 2]]);
    const next = lowerBaseline(current, base);
    expect(next[victim]).toBe(1);
    expect(next).not.toHaveProperty("packages/new-file.ts");
    expect(rises(current, next)).toEqual(
      [
        "packages/new-file.ts: baseline=0 current=2",
        `${victim}: baseline=1 current=${victimCount}`,
      ].sort()
    );
  });

  it("a new swallow in a new file is red, and an empty reason is reported (the ratchet can fail)", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-empty-"));
    try {
      writeFileSync(
        join(dir, "regress.ts"),
        "export const r = () => hub.list().catch(() => []);\n"
      );
      writeFileSync(
        join(dir, "noreason.ts"),
        "// empty-ok:\nexport const r = () => fetch(u).catch(() => []);\n"
      );
      const extra = scanBackend(listSourceFiles([dir]));
      const merged = new Map([...counts, ...extra.counts]);
      expect(rises(merged, baseline.files).join("\n")).toMatch(
        /regress\.ts: baseline=0 current=1/
      );
      expect(extra.emptyReasons.join("\n")).toMatch(/noreason\.ts:1$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The mirror: backend CI lays out ../synap-app beside this checkout
// (.github/actions/monorepo-setup), so there it is MEASURED, and an absent
// checkout is a broken pipeline (siblingRequired). A backend-only local or
// devbox run skips it, saying so.
const appRoot = siblingCheckout("synap-app");
const SOURCE_DIR = appRoot
  ? join(appRoot, "packages/design-tokens/scripts")
  : null;
if (!SOURCE_DIR)
  console.warn(siblingSkipReason("synap-app", "failure-empty mirror"));

describe("failure-empty detector mirror", () => {
  if (!SOURCE_DIR) {
    it.skipIf(!siblingRequired())(
      "synap-app is checked out beside backend (CI lays it out)",
      () => {
        expect.fail(siblingSkipReason("synap-app", "failure-empty mirror"));
      }
    );
    return;
  }
  for (const name of MIRRORED) {
    it(`${name} is byte-identical to synap-app's source`, () => {
      const source = join(SOURCE_DIR, name);
      expect(
        existsSync(source),
        `synap-app has no ${name}: it is the source of truth`
      ).toBe(true);
      expect(
        readFileSync(join(here, name)).equals(readFileSync(source)),
        `Edit synap-app's ${name} and copy it here, byte for byte`
      ).toBe(true);
    });
  }
});
