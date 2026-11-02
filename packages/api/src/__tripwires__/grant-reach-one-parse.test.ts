import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE (ratchet) — a grant's reach is read through ONE parse.
 *
 * Access model B (founder decision of 2 Nov 2026, plan 2c8fca91 §1): a
 * grant's missing space list meant "anywhere" to a key, "a pod-wide read" to
 * an app, and `[]` meant four things, because each reader interpreted
 * `workspaceIds` by hand (`=== null`, `!x.workspaceIds`, `?? []`, `.length`).
 * The bugs of #546 and #636 were exactly such readers. Now `parsePlace` /
 * `parseRequestPlace` / `placeBeyondPodWideReads`
 * (`packages/types/src/grants/reach.ts`) read it once into an explicit
 * `Place`, and callers switch on `place.kind`.
 *
 * INVARIANT: no grant-domain file interprets `workspaceIds` by hand beyond
 * its baseline below. The baseline is SHRINK-ONLY: a file over it is red (use
 * the parse); a file under it is red too, so the baseline is lowered in the
 * same change and the improvement is kept. Never raise a number, never add a
 * file.
 *
 * SCANNED SET (derived, never hand-listed): every non-test `.ts` / `.tsx`
 * file under `packages/types/src`, `packages/api/src`, `packages/database/src`
 * and `apps/pod-admin/app` that is about grants — it imports a grants module
 * (`…/grants`) or names a grant type (`KeyGrant`, `GrantScope`, `GrantDraft`,
 * `KeyAccessGrant`, `GrantInput`). `reach.ts` and `pod-wide.ts` are the parse
 * and its rule, exempt by definition.
 *
 * What stays in the baseline and why (each reads a raw list on purpose):
 *  - `grammar.ts` `permits` / `isNarrowedScope` — the oracle every other
 *    reading is checked against; `null` = no space check, `[]` = nowhere.
 *  - `algebra.ts` — meet / within work on the raw pinning axes alike
 *    (spaces, projects, objects); which holder a missing list belongs to is
 *    not its question.
 *  - `grant-door-fence.ts` — owned this wave by lane w1-r1; moves next.
 *  - the rest: readers that ask about a space LIST (copy, intersect, narrow
 *    a list to a list) rather than about "no space"; each moves when touched.
 */

// Paths relative to the backend repo root.
const EXEMPT = new Set<string>([
  "packages/types/src/grants/reach.ts",
  "packages/types/src/grants/pod-wide.ts",
]);

/** File → count of raw `workspaceIds` interpretations allowed today. Shrink-only. */
const BASELINE: Readonly<Record<string, number>> = {
  "packages/types/src/apps/app-view.ts": 1,
  "packages/types/src/grants/algebra.ts": 1,
  "packages/types/src/grants/grammar.ts": 2,
  "packages/types/src/grants/key-steps.ts": 2,
  "packages/types/src/grants/listed.ts": 1,
  "packages/types/src/grants/presets.ts": 1,
  "packages/types/src/grants/summary.ts": 1,
  "packages/api/src/access/grant-door-fence.ts": 2,
  "packages/api/src/routers/api-keys.ts": 2,
  "packages/api/src/routers/grant-roles.ts": 1,
  "packages/api/src/routers/hub-protocol/rest/setup.ts": 1,
  "packages/api/src/services/agent-connect.ts": 2,
  "packages/api/src/services/app-connect.ts": 2,
  "packages/api/src/services/key-grant.ts": 6,
  "packages/api/src/services/key-requests.ts": 8,
  "apps/pod-admin/app/(admin)/keys/_lib/key-sections.tsx": 2,
  "apps/pod-admin/app/keys/requests/[id]/KeyRequestReview.tsx": 1,
};

/** The raw interpretations of a space list, by hand. */
const RAW: readonly RegExp[] = [
  // `x.workspaceIds === null`, `!= null`, `=== undefined` …
  /\bworkspaceIds\s*[!=]==?\s*(?:null|undefined)\b/g,
  // `!x.workspaceIds`, `!scope?.workspaceIds` (a negated list, not `!==`)
  /(?<![\w$)\]])!\s*(?:[\w$]+\??\.)*workspaceIds\b(?!\s*[!=]=)/g,
  // `workspaceIds ?? …`, `workspaceIds || …`, `workspaceIds && …`
  /\bworkspaceIds\s*(?:\?\?|\|\||&&)/g,
  // `workspaceIds.length`, `workspaceIds?.length`
  /\bworkspaceIds\s*\??\.\s*length\b/g,
  // `workspaceIds ? a : b` (truthiness; not `?.`, `??` or an optional `?:`)
  /\bworkspaceIds\s*\?(?![.?:])/g,
];

const GRANT_DOMAIN =
  /from\s+["'][^"']*\/grants(?:\/[\w.-]+)?(?:\.js)?["']|\b(?:KeyGrant|GrantScope|GrantDraft|KeyAccessGrant|GrantInput)\b/;

function countRaw(src: string): number {
  return RAW.reduce((n, re) => n + (src.match(re)?.length ?? 0), 0);
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".next" ||
      entry.name === "__tests__" ||
      entry.name === "__tripwires__"
    )
      continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, acc);
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec|stories)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    )
      acc.push(p);
  }
  return acc;
}

const ROOT = join(process.cwd(), "..", "..");
const SCAN_ROOTS = [
  "packages/types/src",
  "packages/api/src",
  "packages/database/src",
  "apps/pod-admin/app",
];

function scan(): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const f of sourceFiles(abs)) {
      const rel = relative(ROOT, f);
      if (EXEMPT.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      if (!GRANT_DOMAIN.test(src)) continue;
      out.set(rel, countRaw(src));
    }
  }
  return out;
}

describe("tripwire: a grant's reach is read through one parse (access model B)", () => {
  const found = scan();

  it("scans a real set of grant files (non-vacuity)", () => {
    for (const root of SCAN_ROOTS)
      expect(
        statSync(join(ROOT, root), { throwIfNoEntry: false })?.isDirectory(),
        root
      ).toBe(true);
    expect(found.size).toBeGreaterThan(40);
    for (const f of [
      "packages/types/src/grants/holder.ts",
      "packages/types/src/grants/grammar.ts",
      "packages/api/src/services/app-connect.ts",
      "apps/pod-admin/app/oauth/consent/consent-model.ts",
    ])
      expect(found.has(f), f).toBe(true);
    // The baseline counts real interpretations: the oracle has some.
    expect(found.get("packages/types/src/grants/grammar.ts")).toBeGreaterThan(
      0
    );
  });

  it("no file interprets `workspaceIds` by hand beyond its baseline", () => {
    const over: string[] = [];
    for (const [file, n] of found) {
      const allowed = BASELINE[file] ?? 0;
      if (n > allowed)
        over.push(`${file}: ${n} > ${allowed} — read it with parsePlace`);
    }
    expect(over).toEqual([]);
  });

  it("the baseline only shrinks: a file under it lowers it in the same change", () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const n = found.get(file) ?? 0;
      if (n < allowed)
        stale.push(`${file}: now ${n}, lower ${allowed} to ${n}`);
    }
    expect(stale).toEqual([]);
  });

  it("the detector catches each raw spelling and spares the parse's (self-check)", () => {
    const raw = [
      "if (scope.workspaceIds === null) {}",
      "if (g.workspaceIds == undefined) {}",
      "if (!scope.workspaceIds) {}",
      "if (!s?.workspaceIds) {}",
      "const ids = scope.workspaceIds ?? [];",
      "const a = g.workspaceIds || [];",
      "if (g.workspaceIds && x) {}",
      "if (g.workspaceIds?.length) {}",
      "if (g.workspaceIds.length === 0) {}",
      "const w = g.workspaceIds ? g.workspaceIds : null;",
    ];
    for (const line of raw) expect(countRaw(line), line).toBeGreaterThan(0);
    const clean = [
      "const place = parsePlace(scope, holderOfGrant(grant));",
      "interface S { workspaceIds?: readonly string[] | null }",
      "const x = { workspaceIds: [id] };",
      "if (a !== b.workspaceIds) {}",
      "return { ...scope, workspaceIds: place.ids };",
    ];
    for (const line of clean) expect(countRaw(line), line).toBe(0);
  });
});
