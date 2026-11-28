/**
 * TRIPWIRE (per-file ratchet) — the generic backend carries no domain logic.
 *
 * THE RULE (founder, 27 Nov 2026; pod skill `rules/agnostic-backend`): the
 * generic backend knows kinds, lifecycles, playbooks, automations,
 * capabilities and holds, never a DOMAIN. Dev, CRM, content... are catalog
 * content in a space: a kind + its declared lifecycle (moved with
 * `moveStatus`), an automation + a capability, a hold that waits on a thing's
 * `moves`. Generic code that names a pull request, a devbox job or a `"lead"`
 * is a workflow hard-coded where configuration belongs.
 *
 * WHAT IT COUNTS: `./agnostic-backend-detector.mjs` (read its header for the
 * token list, what each token means, and what it DOES NOT SEE). Two families,
 * read from the TypeScript AST so comments never count:
 *   - dev: dev-flow word sequences in identifiers and strings
 *     (`pull request`, `pr merged`, `ci finished`, `devbox`, `negctl`...);
 *   - domain: a catalog kind or status as a whole string literal (`"lead"`,
 *     `"deal"`), positional for the ambiguous ones (`"post"` as a kind,
 *     `"Published"` as a status).
 * Scanned layers (derived by walking, a new file joins by existing):
 * `packages/api/src/{services,routers}`, `packages/jobs/src`,
 * `packages/types/src`, `packages/database/src/{services,utils}`; tests,
 * fixtures, `__tripwires__` and declarations are skipped. The parked Arch
 * leftovers are out of scope by construction: no token names them.
 *
 * THE BASELINE IS THE REMOVAL CHECKLIST: `agnostic-backend-baseline.json`
 * holds per-file ceilings in two groups, `dev` ("remove when the Dev flow pack
 * lands") and `domain` ("move to catalog"); each group's `total` must reach 0.
 * Taken 2026-11-27 at main b80b110b9c, nothing cleaned up.
 *
 * RED WHEN: a file rises above its ceiling in a group, or a file not in the
 * baseline gains a hit (a new file starts at 0). Put the logic in config
 * instead (the three doors above); never hand-raise a ceiling.
 *
 * LOWER IT (after removing code):
 *   AGNOSTIC_BACKEND_UPDATE=1 npx vitest run scripts/agnostic-backend.tripwire.test.ts
 * rewrites the baseline with each ceiling lowered to its current count; it
 * never raises one or admits a new file. Commit the lowered JSON with the
 * removal. `AGNOSTIC_BACKEND_REPORT=1` prints hits per token and per layer.
 *
 * ALLOWLIST (legitimate generic homes, not counted): `ALLOWLIST` in the
 * detector, one reason per path; an entry whose file is gone or no longer
 * has a hit is RED, so the list cannot rot.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  DEV_TOKENS,
  ROOTS,
  countDomainVocabulary,
  scanAgnosticBackend,
} from "./agnostic-backend-detector.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..");
const BASELINE = join(here, "agnostic-backend-baseline.json");

type Group = "dev" | "domain";
const GROUPS: Group[] = ["dev", "domain"];
type Baseline = {
  generated: string;
  how: string;
  groups: Record<
    Group,
    { label: string; total: number; files: Record<string, number> }
  >;
};
type Counts = Map<string, { dev: number; domain: number }>;

/** Files above their ceiling in a group (a missing key is a ceiling of 0). */
function rises(current: Counts, base: Baseline["groups"]): string[] {
  const out: string[] = [];
  for (const [file, c] of current)
    for (const g of GROUPS) {
      const ceiling = base[g].files[file] ?? 0;
      if (c[g] > ceiling)
        out.push(`${g} ${file}: baseline=${ceiling} current=${c[g]}`);
    }
  return out.sort();
}

/** What AGNOSTIC_BACKEND_UPDATE=1 writes: ceilings only fall, no file enters. */
function lowerBaseline(
  current: Counts,
  base: Baseline["groups"]
): Baseline["groups"] {
  const next = {} as Baseline["groups"];
  for (const g of GROUPS) {
    const files: Record<string, number> = {};
    for (const [k, ceiling] of Object.entries(base[g].files)) {
      const cur = current.get(k)?.[g] ?? 0;
      if (cur > 0) files[k] = Math.min(cur, ceiling);
    }
    const sorted = Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    );
    next[g] = {
      label: base[g].label,
      total: Object.values(sorted).reduce((a, b) => a + b, 0),
      files: sorted,
    };
  }
  return next;
}

/** One sample per dev token: each must count exactly once on its own. */
const DEV_SAMPLES: Record<string, string> = {
  "pull request": "export const pullRequestUrl = 1;",
  "pr merged|opened|closed": 'export const t = "dev.pr_merged";',
  "pr state|checks|url|number|ref": "export const prState = 1;",
  "ci started|finished": 'export const t = "ci.finished";',
  "required checks": "export const requiredChecks = 1;",
  "repo snapshot|health": 'export const t = "dev.repo_snapshot";',
  "merge queue": 'export const t = "merge_queue";',
  "main red": "export const mainRed = 1;",
  negctl: 'export const t = "negctl";',
  devbox: 'export const t = "a devbox job";',
  devplane: 'export const t = "devplane_app";',
  "dev loop": "export const DEV_LOOP = 1;",
  "dev hold|signal|fact|event": "export const devSignals = 1;",
  "work release": 'export const t = "work-release";',
};

/** Generic code that must NOT count (each one a near-miss the tokens avoid). */
const GENERIC_SAMPLES: [string, string][] = [
  [
    "a comment about pull requests",
    '// a pull request, devbox, "lead"\n/* dev.pr_merged */ export const a = 1;',
  ],
  [
    "`pr` meaning pending review",
    "const pr = queue.pendingReview; if (pr.count > 0) f();",
  ],
  ["an HTTP method", 'route({ method: "post", path: "/x" });'],
  ["a verb label", 'const v = { imperative: "Publish", past: "Published" };'],
  [
    "generic lifecycle categories",
    'if (status === "won" || status === "lost") f();',
  ],
  [
    "system kinds and OAuth clients",
    'const k = { profileSlug: "contact", type: "client" };',
  ],
  [
    "generic acceptance criteria",
    'const d = "[{ key, statement, required?, check: { kind } }]";',
  ],
  ["generic site sharing", 'if (site.status === "published") f();'],
  ["a word inside prose", 'const d = "e.g. a deal or a lead";'],
];

const DOMAIN_SAMPLES: [string, string, number][] = [
  ["a CRM kind literal", 'if (e.profileSlug === "deal") f();', 1],
  ["a CRM role constant", 'export const BOOKING_LEAD_ROLE = "lead";', 1],
  ["a content kind in a kind position", 'const POST_KIND = "post";', 1],
  [
    "a content status in a status position",
    'const PUBLISHED_STATUS = "Published";',
    1,
  ],
  ["a CRM status compared with a stage", 'if (stage === "engaged") f();', 1],
];

describe("the generic backend names no domain (per-file ratchet over the generic layers)", () => {
  const scan = scanAgnosticBackend(REPO);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
  const total = (g: Group) =>
    [...scan.perFile.values()].reduce((a, c) => a + c[g], 0);

  if (process.env.AGNOSTIC_BACKEND_REPORT === "1") {
    const byRoot: Record<
      string,
      { dev: number; domain: number; files: number }
    > = {};
    for (const [f, c] of scan.perFile) {
      const r = ROOTS.find((x) => f.startsWith(`${x}/`)) ?? "?";
      byRoot[r] ??= { dev: 0, domain: 0, files: 0 };
      byRoot[r].dev += c.dev;
      byRoot[r].domain += c.domain;
      byRoot[r].files += 1;
    }
    console.log(
      JSON.stringify(
        {
          files: scan.files,
          dev: total("dev"),
          domain: total("domain"),
          tokens: scan.tokens,
          byRoot,
          allowlisted: scan.allowlisted,
        },
        null,
        2
      )
    );
  }

  it("scans a plausible number of files and finds real hits (non-vacuity)", () => {
    // 2,456 files, 1,496 dev hits in 98 files, 20 domain hits in 6 files on 2026-11-27.
    expect(scan.files).toBeGreaterThan(2000);
    expect(total("dev")).toBeGreaterThan(1000);
    expect(total("domain")).toBeGreaterThanOrEqual(10);
    expect(Object.keys(baseline.groups.dev.files).length).toBeGreaterThan(50);
    for (const r of ROOTS)
      expect(existsSync(join(REPO, r)), `${r} is gone: fix ROOTS`).toBe(true);
  });

  it("still sees the pinned real sites (non-vacuity)", () => {
    // When these are removed (the goal), pin the next ones from the baseline.
    expect(
      scan.perFile.get("packages/types/src/events/dev-loop.ts")?.dev ?? 0
    ).toBeGreaterThan(50);
    expect(
      scan.perFile.get(
        "packages/api/src/services/postiz/record-postiz-published.ts"
      )?.domain ?? 0
    ).toBeGreaterThan(0);
    expect(
      scan.perFile.get(
        "packages/api/src/services/calcom/map-booking-to-graph.ts"
      )?.domain ?? 0
    ).toBeGreaterThan(0);
  });

  it("every dev token counts its own sample exactly once (each token can fire)", () => {
    expect(Object.keys(DEV_SAMPLES).sort()).toEqual(
      DEV_TOKENS.map((t) => t.id).sort()
    );
    for (const t of DEV_TOKENS) {
      const c = countDomainVocabulary("sample.ts", DEV_SAMPLES[t.id]!);
      expect(c.tokens, t.id).toEqual({ [`dev:${t.id}`]: 1 });
    }
  });

  for (const [what, src, n] of DOMAIN_SAMPLES)
    it(`counts a domain sample: ${what}`, () => {
      const c = countDomainVocabulary("sample.ts", src);
      expect(c.domain).toBe(n);
      expect(c.dev).toBe(0);
    });

  for (const [what, src] of GENERIC_SAMPLES)
    it(`does not count generic code: ${what}`, () => {
      expect(countDomainVocabulary("sample.ts", src).tokens).toEqual({});
    });

  it("every allowlist entry has a reason, exists, and still has a hit (no rot)", () => {
    for (const [path, why] of Object.entries(ALLOWLIST)) {
      expect(
        why.trim().length,
        `${path}: say why it is a generic home`
      ).toBeGreaterThan(10);
      expect(
        existsSync(join(REPO, path)),
        `${path} is gone: remove it from ALLOWLIST`
      ).toBe(true);
      expect(
        scan.allowlisted[path] ?? 0,
        `${path} has no hit left: remove it from ALLOWLIST`
      ).toBeGreaterThan(0);
    }
  });

  it("the baseline is well formed: two groups, totals match their files", () => {
    expect(Object.keys(baseline.groups).sort()).toEqual([...GROUPS].sort());
    for (const g of GROUPS) {
      const files = baseline.groups[g].files;
      expect(
        baseline.groups[g].total,
        `${g}.total must equal the sum of its files`
      ).toBe(Object.values(files).reduce((a, b) => a + b, 0));
      for (const [k, v] of Object.entries(files)) {
        expect(
          Number.isInteger(v) && v > 0,
          `${g} ${k}: a ceiling is a positive integer`
        ).toBe(true);
        expect(
          Object.hasOwn(ALLOWLIST, k),
          `${k} is allowlisted AND in the baseline`
        ).toBe(false);
      }
    }
  });

  it("no file rose above its baseline ceiling", () => {
    if (process.env.AGNOSTIC_BACKEND_UPDATE === "1") {
      const next: Baseline = {
        ...baseline,
        generated: new Date().toISOString().slice(0, 10),
        groups: lowerBaseline(scan.perFile, baseline.groups),
      };
      writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
    }
    expect(
      rises(scan.perFile, baseline.groups),
      "The generic backend names no domain: express it as a kind + lifecycle (moveStatus), an automation + capability, or a hold on `moves` (pod skill rules/agnostic-backend). Never hand-raise the baseline"
    ).toEqual([]);
  });

  // The two mechanism tests below start from counts AT the baseline, not from
  // the live scan, so a real rise reds only the ratchet test above (one cause,
  // one red; seen in the negative control of 2026-11-27).
  const atCeiling: Counts = new Map();
  for (const g of GROUPS)
    for (const [f, n] of Object.entries(baseline.groups[g].files)) {
      const c = atCeiling.get(f) ?? { dev: 0, domain: 0 };
      c[g] = n;
      atCeiling.set(f, c);
    }

  it("the update never raises a ceiling or admits a new file, and the rise stays red", () => {
    const [victim, ceiling] = Object.entries(baseline.groups.dev.files).sort(
      (a, b) => b[1] - a[1]
    )[0]!;
    expect(
      ceiling,
      "victim must carry >1 hit for this test to mean anything"
    ).toBeGreaterThan(1);
    const base = structuredClone(baseline.groups);
    base.dev.files[victim] = 1;
    const current: Counts = new Map([
      ...atCeiling,
      ["packages/types/src/new-file.ts", { dev: 2, domain: 1 }],
    ]);
    const next = lowerBaseline(current, base);
    expect(next.dev.files[victim]).toBe(1);
    expect(next.dev.files).not.toHaveProperty("packages/types/src/new-file.ts");
    expect(next.domain.files).not.toHaveProperty(
      "packages/types/src/new-file.ts"
    );
    expect(rises(current, next)).toEqual(
      [
        "dev packages/types/src/new-file.ts: baseline=0 current=2",
        "domain packages/types/src/new-file.ts: baseline=0 current=1",
        `dev ${victim}: baseline=1 current=${current.get(victim)!.dev}`,
      ].sort()
    );
  });

  it("a new dev token in a new generic file is red (the ratchet can fail end to end)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agnostic-backend-"));
    try {
      const svc = join(dir, "packages/api/src/services/probe");
      mkdirSync(svc, { recursive: true });
      writeFileSync(
        join(svc, "probe.ts"),
        'export const onMerge = (e: { type: string }) => e.type === "dev.pr_merged";\n'
      );
      writeFileSync(
        join(svc, "probe.test.ts"),
        'export const skipped = "dev.pr_merged";\n'
      );
      for (const r of ROOTS) mkdirSync(join(dir, r), { recursive: true });
      const extra = scanAgnosticBackend(dir);
      expect(
        extra.files,
        "the test file is skipped, the source file is read"
      ).toBe(1);
      const merged: Counts = new Map([...atCeiling, ...extra.perFile]);
      expect(rises(merged, baseline.groups)).toEqual([
        "dev packages/api/src/services/probe/probe.ts: baseline=0 current=1",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
