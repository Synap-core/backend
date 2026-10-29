/**
 * culprit-finder.mjs names the PR that made main red and, after 30 min with
 * nobody fixing it, opens a revert PR that jumps the merge queue (founder
 * decision 0b4db9f7). A wrong name sends a person to the wrong PR; a wrong
 * revert takes out someone's merged work, or fights the one owner of a red
 * (.claude/rules/github-ci.md "Never pile onto a red main"). This pins:
 * the failing files read from RECORDED logs of the real red run 40797830929
 * (29 Oct, 01:46Z), the attribution and the bisect on that run's real range,
 * the verdict's no-revert rules, the revert rule row by row, and the name,
 * post and sweep flows end to end through a fake GitHub, a fake pod and a
 * fake shell (a fake `gh` binary for the wire).
 * NOT COVERED: the real probe (install, database, vitest at an old commit)
 * runs only on GitHub; the workflow file is read as text.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIX_BRANCH_RE,
  GRACE_MINUTES,
  MAX_PROBES,
  RECORD_CHECK,
  RECORD_WORKFLOW,
  REVERT_BRANCH_RE,
  attribute,
  bisect,
  bisectHints,
  buildFilters,
  failingFiles,
  ghTransport,
  isFixMerge,
  main,
  makeProbe,
  needsBisect,
  podClient,
  readMarker,
  readRecord,
  recordOf,
  recordText,
  revertBranch,
  revertDecision,
  trustedBisect,
  verdict,
  // @ts-expect-error — plain ESM script, no declarations
} from "./culprit-finder.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { loadGraph } from "./affected.mjs";
// @ts-expect-error — plain ESM script, no declarations
import { isTripwire } from "../tripwire-discovery.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIX = join(REPO, "scripts/ci/__fixtures__/red-main-40797830929");
const FULL_SUITE_LOG = readFileSync(join(FIX, "full-suite.txt"), "utf8");
const RELEASE_GATE_LOG = readFileSync(join(FIX, "release-gate.txt"), "utf8");
const REAL = JSON.parse(readFileSync(join(FIX, "prs.json"), "utf8"));
const PR = Object.fromEntries(REAL.prs.map((p: any) => [p.number, p]));
const SESSION = "11111111-2222-4333-8444-555555555555";
const OBS =
  "packages/api/src/routers/hub-protocol/observations.contract.test.ts";
const GRANT = "packages/api/src/access/grant-read-coverage.tripwire.test.ts";
const TRIG =
  "packages/api/src/__tripwires__/trigger-subject-has-producer.test.ts";
const MIG = "packages/database/src/migrations-0371.pglite.test.ts";

const sha = (c: string) => c.repeat(40).slice(0, 40);
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

// ── a small synthetic graph: b depends on a; c stands alone ─────────────────
const GRAPH = {
  graph: new Map([
    ["packages/a", new Set(["packages/b"])],
    ["packages/b", new Set()],
    ["packages/c", new Set()],
  ]),
  refs: [],
  isTripwire,
};

describe("failingFiles: what a red run names (recorded logs of run 40797830929)", () => {
  it("the Full suite judge: the ratchet's three new failures, nothing else", () => {
    expect(failingFiles(FULL_SUITE_LOG)).toEqual([
      { file: OBS, kind: "test" },
      { file: GRANT, kind: "test" },
      { file: TRIG, kind: "test" },
    ]);
  });

  it("the Release gate: the one eslint ERROR file; files with warnings only are not red", () => {
    expect(failingFiles(RELEASE_GATE_LOG)).toEqual([
      { file: MIG, kind: "lint" },
    ]);
  });

  it("tsc (a turbo prefix resolves the package), prettier, [fixed]/[stale-baseline]; [flaky] is not red", () => {
    const log = [
      "2026-10-29T01:00:00.0000000Z @synap/api:typecheck: src/x.ts(3,7): error TS2322: no",
      "packages/types/src/y.ts(1,1): error TS2307: no",
      "[warn] packages/jobs/src/z.ts",
      "  [fixed]",
      "      packages/c/src/old.test.ts",
      "  [stale-baseline]",
      "      packages/c/src/gone.test.ts",
      "  [flaky]",
      "      packages/c/src/flaky.test.ts",
    ].join("\n");
    expect(
      failingFiles(log, {
        dirsByName: new Map([["@synap/api", "packages/api"]]),
      })
    ).toEqual([
      { file: "packages/api/src/x.ts", kind: "type" },
      { file: "packages/types/src/y.ts", kind: "type" },
      { file: "packages/jobs/src/z.ts", kind: "lint" },
      { file: "packages/c/src/old.test.ts", kind: "fixed" },
      { file: "packages/c/src/gone.test.ts", kind: "stale" },
    ]);
  });
});

describe("attribute: cheapest correct method first", () => {
  const c = (s: string, pr: number, files: string[] | null) => ({
    sha: sha(s),
    pr,
    files,
  });
  const f = (file: string) => [{ file, kind: "test" }];

  it("a range of ONE commit: that commit, high", () => {
    const a = attribute(
      f("packages/c/src/x.test.ts"),
      [c("a", 1, ["packages/x/src/unrelated.ts"])],
      GRAPH
    );
    expect(a.get("packages/c/src/x.test.ts")).toMatchObject({
      method: "range",
      confidence: "high",
    });
  });

  it("exactly one PR changed the file and no other reaches it: high; two changed it: ambiguous", () => {
    const one = attribute(
      f("packages/c/src/x.test.ts"),
      [
        c("a", 1, ["packages/c/src/x.test.ts"]),
        c("b", 2, ["packages/a/src/y.ts"]),
      ],
      GRAPH
    );
    expect(one.get("packages/c/src/x.test.ts")).toMatchObject({
      method: "direct",
      confidence: "high",
      shas: [sha("a")],
    });
    const two = attribute(
      f("packages/c/src/x.test.ts"),
      [
        c("a", 1, ["packages/c/src/x.test.ts"]),
        c("b", 2, ["packages/c/src/x.test.ts"]),
      ],
      GRAPH
    );
    expect(two.get("packages/c/src/x.test.ts")).toMatchObject({
      method: "ambiguous",
      confidence: "low",
    });
  });

  // M3 (review of #513): PR A renames an export in package a; PR B edits
  // unrelated lines of b's file F; F fails. "B changed F" is not proof.
  it("one PR changed the file but ANOTHER can reach it: medium, and it goes to the bisect with B as the suspect", () => {
    const F = "packages/b/src/f.test.ts";
    const a = attribute(
      f(F),
      [c("a", 1, ["packages/a/src/index.ts"]), c("b", 2, [F])],
      GRAPH
    );
    expect(a.get(F)).toMatchObject({
      method: "direct",
      confidence: "medium",
      shas: [sha("b")],
      others: 1,
    });
    expect(needsBisect(f(F), a).map((x: any) => x.file)).toEqual([F]);
    expect(bisectHints([F], a).get(F)).toBe(sha("b"));
  });

  it("only one PR can REACH it (a dependency of its package): medium", () => {
    const a = attribute(
      f("packages/b/src/x.test.ts"),
      [c("a", 1, ["packages/a/src/y.ts"]), c("b", 2, ["packages/c/src/z.ts"])],
      GRAPH
    );
    expect(a.get("packages/b/src/x.test.ts")).toMatchObject({
      method: "reach",
      confidence: "medium",
      shas: [sha("a")],
    });
  });

  it("a tripwire reads across the tree: every PR reaches it; a docs-only PR reaches nothing; an unread PR reaches everything", () => {
    const t = attribute(
      f("packages/b/src/__tripwires__/t.test.ts"),
      [c("a", 1, ["packages/c/src/z.ts"]), c("b", 2, ["packages/c/src/w.ts"])],
      GRAPH
    );
    expect(t.get("packages/b/src/__tripwires__/t.test.ts")).toMatchObject({
      method: "ambiguous",
    });
    const d = attribute(
      f("packages/b/src/x.test.ts"),
      [c("a", 1, ["docs/guide.md"]), c("b", 2, ["packages/a/src/y.ts"])],
      GRAPH
    );
    expect(d.get("packages/b/src/x.test.ts")).toMatchObject({
      method: "reach",
      shas: [sha("b")],
    });
    const u = attribute(
      f("packages/c/src/x.test.ts"),
      [c("a", 1, null), c("b", 2, ["packages/a/src/y.ts"])],
      GRAPH
    );
    expect(u.get("packages/c/src/x.test.ts")).toMatchObject({
      method: "reach",
      shas: [sha("a")],
    });
  });

  it("the real 29 Oct range: the lint red is #467's own file but other PRs reach it (medium); everything goes to ONE bisect", () => {
    const g = loadGraph(REPO, isTripwire);
    const candidates = REAL.prs.map((p: any) => ({
      sha: p.mergeSha,
      pr: p.number,
      files: p.files,
    }));
    const failing = [
      ...failingFiles(FULL_SUITE_LOG),
      ...failingFiles(RELEASE_GATE_LOG),
    ];
    const a = attribute(failing, candidates, { ...g, isTripwire });
    expect(a.get(MIG)).toMatchObject({
      method: "direct",
      confidence: "medium",
      shas: [PR[467].mergeSha],
    });
    for (const file of [OBS, GRANT, TRIG])
      expect(a.get(file).confidence).toBe("low");
    expect(needsBisect(failing, a).map((x: any) => x.file)).toEqual([
      OBS,
      GRANT,
      TRIG,
      MIG,
    ]);
  }, 30_000);
});

describe("bisect: only the unsettled files, at a few commits, in one job", () => {
  const shas = REAL.prs.map((p: any) => p.mergeSha);
  const idx = (s: string) => shas.indexOf(s);
  const breaker = (by: Record<string, string>) => {
    const calls: Array<{ sha: string; files: string[] }> = [];
    const probe = async (s: string, files: string[]) => {
      calls.push({ sha: s, files });
      return new Map(
        files.map((f) => [f, idx(s) >= idx(by[f]) ? "fail" : "pass"])
      );
    };
    return { calls, probe };
  };

  it("29 Oct: #476 for the three test files, #467 for the lint file (its hint confirmed in 2 probes), each confirmed by a repeat, within MAX_PROBES", async () => {
    const by = {
      [OBS]: PR[476].mergeSha,
      [GRANT]: PR[476].mergeSha,
      [TRIG]: PR[476].mergeSha,
      [MIG]: PR[467].mergeSha,
    };
    const { calls, probe } = breaker(by);
    const { results, probes } = await bisect(
      shas,
      [OBS, GRANT, TRIG, MIG],
      probe,
      { hints: new Map([[MIG, PR[467].mergeSha]]) }
    );
    for (const f of [OBS, GRANT, TRIG])
      expect(results.get(f)).toMatchObject({
        sha: PR[476].mergeSha,
        confidence: "high",
      });
    expect(results.get(MIG)).toMatchObject({
      sha: PR[467].mergeSha,
      confidence: "high",
    });
    expect(results.get(OBS).why).toContain(PR[467].mergeSha.slice(0, 9)); // its first parent passes
    expect(results.get(OBS).why).toContain("failed again on a repeat");
    // The hint: the suspect, then its first parent, first.
    expect(calls.slice(0, 2).map((c) => c.sha)).toEqual([
      PR[467].mergeSha,
      PR[465].mergeSha,
    ]);
    // The confirmation: one fresh probe per named commit, its files together.
    expect(calls.at(-2)).toEqual({ sha: PR[467].mergeSha, files: [MIG] });
    expect(calls.at(-1)).toEqual({
      sha: PR[476].mergeSha,
      files: [OBS, GRANT, TRIG],
    });
    expect(probes).toBe(6); // 2 for the hint, the red commit, 1 search step, 2 repeats
    expect(probes).toBeLessThanOrEqual(MAX_PROBES);
  });

  it("a hint that is wrong (the file fails before the suspect) falls back to the search", async () => {
    const { probe } = breaker({ [OBS]: PR[467].mergeSha });
    const { results } = await bisect(shas, [OBS], probe, {
      hints: new Map([[OBS, PR[476].mergeSha]]),
    });
    expect(results.get(OBS).sha).toBe(PR[467].mergeSha);
  });

  it("a flake that failed once at a probed commit is not named: the repeat passes (N8)", async () => {
    let n = 0;
    const probe = async (s: string, files: string[]) => {
      // fails only on its first run at #470 and every run at the red commit
      const fail = s === shas.at(-1) || (s === PR[470].mergeSha && n++ === 0);
      return new Map(files.map((f) => [f, fail ? "fail" : "pass"]));
    };
    const { results } = await bisect(shas, [OBS], probe);
    expect(results.get(OBS)).toMatchObject({ sha: null, confidence: "low" });
    expect(results.get(OBS).why).toContain("did not fail on a repeat");
  });

  it("a file that passes alone at the red commit names nobody (low); a file absent earlier counts as passing there", async () => {
    const flaky = await bisect(
      shas,
      [OBS],
      async (_s: string, files: string[]) =>
        new Map(files.map((f) => [f, "pass"]))
    );
    expect(flaky.results.get(OBS)).toMatchObject({
      sha: null,
      confidence: "low",
    });
    expect(flaky.results.get(OBS).why).toContain("did not fail when run alone");
    const added = await bisect(
      shas,
      [OBS],
      async (s: string, files: string[]) =>
        new Map(
          files.map((f) => [
            f,
            idx(s) >= idx(PR[475].mergeSha) ? "fail" : "absent",
          ])
        )
    );
    expect(added.results.get(OBS).sha).toBe(PR[475].mergeSha);
  });

  it(`stops at the probe budget (default ${MAX_PROBES}) and says where it got to`, async () => {
    const { probe } = breaker({ [OBS]: PR[476].mergeSha });
    const { results, probes } = await bisect(shas, [OBS], probe, {
      maxProbes: 2,
    });
    expect(probes).toBe(2);
    expect(results.get(OBS)).toMatchObject({ sha: null, confidence: "low" });
    expect(results.get(OBS).why).toContain("used its 2 probes");
  });

  it("the post job keeps only what the plan allows from a bisect result (it ran merged code)", () => {
    const plan = {
      bisect: [OBS],
      candidates: REAL.prs.map((p: any) => ({ sha: p.mergeSha, pr: p.number })),
    };
    const t = trustedBisect(plan, {
      bisected: {
        [OBS]: { sha: PR[476].mergeSha, confidence: "high", why: "x" },
        [GRANT]: { sha: PR[476].mergeSha, confidence: "high", why: "added" },
        [TRIG]: { sha: sha("f"), confidence: "high", why: "outside" },
      },
    });
    expect([...t.keys()]).toEqual([OBS]);
    expect(
      trustedBisect(plan, {
        bisected: { [OBS]: { sha: sha("f"), confidence: "high" } },
      }).size
    ).toBe(0);
  });
});

describe("makeProbe: what one probe runs on a real checkout (a fake shell)", () => {
  it("checks the commit out, installs, builds CI's set, migrates a FRESH database, runs each file by its kind", async () => {
    const calls: Array<{
      cmd: string;
      args: string[];
      cwd: string;
      db?: string;
    }> = [];
    const sh = (cmd: string, args: string[], o: any) => {
      calls.push({ cmd, args, cwd: o.cwd, db: o.env?.DATABASE_URL });
      return {
        code: cmd === "pnpm" && args.includes("vitest") ? 1 : 0,
        out: "",
      };
    };
    const filters = buildFilters(
      readFileSync(
        join(REPO, ".github/actions/monorepo-setup/action.yml"),
        "utf8"
      )
    );
    const probe = makeProbe({
      sh,
      root: REPO,
      log: () => {},
      env: { DATABASE_ADMIN_URL: "postgresql://u:p@localhost:5432/postgres" },
      filters,
      kinds: new Map([
        [OBS, "test"],
        [MIG, "lint"],
        ["packages/c/src/missing.test.ts", "test"],
      ]),
    });
    const s = PR[476].mergeSha;
    const res = await probe(s, [OBS, MIG, "packages/c/src/missing.test.ts"]);
    expect(Object.fromEntries(res)).toEqual({
      [OBS]: "fail",
      [MIG]: "pass",
      "packages/c/src/missing.test.ts": "absent",
    });
    const seq = calls.map((c) => `${c.cmd} ${c.args.slice(0, 2).join(" ")}`);
    expect(seq.slice(0, 3)).toEqual([
      "git checkout --force",
      "git clean -fdq",
      "pnpm install --frozen-lockfile",
    ]);
    expect(calls.find((c) => c.args[0] === "turbo")?.args).toEqual([
      "turbo",
      "build",
      ...filters.map((f: string) => `--filter=${f}`),
    ]);
    const create = calls.find((c) => c.cmd === "psql")!.args.at(-1)!;
    const db = /CREATE DATABASE "(probe_[^"]+)"/.exec(create)![1];
    expect(db.startsWith(`probe_${s.slice(0, 12)}`)).toBe(true);
    const url = `postgresql://u:p@localhost:5432/${db}`;
    expect(calls.find((c) => c.args.includes("migrate"))?.db).toBe(url);
    const vitest = calls.find((c) => c.args.includes("vitest"))!;
    expect(vitest.cwd).toBe(join(REPO, "packages/api"));
    expect(vitest.args.at(-1)).toBe(
      "src/routers/hub-protocol/observations.contract.test.ts"
    );
    expect(vitest.db).toBe(url);
    expect(
      calls.some((c) => c.args.includes("prettier") && c.args.includes(MIG))
    ).toBe(true);
    expect(
      calls.some((c) => c.args.includes("eslint") && c.args.includes(MIG))
    ).toBe(true);
  });

  it("a checkout or install that fails answers `error` for every file (never a pass)", async () => {
    const probe = makeProbe({
      sh: () => ({ code: 1, out: "boom" }),
      root: REPO,
      log: () => {},
      env: {},
      filters: [],
      kinds: new Map([[OBS, "test"]]),
    });
    expect(Object.fromEntries(await probe(sha("a"), [OBS]))).toEqual({
      [OBS]: "error",
    });
  });
});

describe("verdict: who is named, and when a revert is even possible", () => {
  const candidates = REAL.prs.map((p: any) => ({
    sha: p.mergeSha,
    pr: p.number,
  }));
  const failing = [
    ...failingFiles(FULL_SUITE_LOG),
    ...failingFiles(RELEASE_GATE_LOG),
  ];
  const high = (s: string) => ({
    method: "direct",
    confidence: "high",
    shas: [s],
  });
  const low = (shas: string[]) => ({
    method: "ambiguous",
    confidence: "low",
    shas,
  });
  const base = { candidates, lastGreen: REAL.lastGreen };
  const one = (over: Record<string, any> = {}) =>
    verdict({
      ...base,
      failing: [{ file: MIG, kind: "lint" }],
      attribution: new Map([[MIG, high(PR[467].mergeSha)]]),
      ...over,
    });

  it("29 Oct: #476 (bisected, three files) and #467 (its own file): two culprits, no automatic revert", () => {
    const attribution = new Map<string, any>([
      [OBS, low(candidates.map((c: any) => c.sha))],
      [GRANT, low(candidates.map((c: any) => c.sha))],
      [TRIG, low(candidates.map((c: any) => c.sha))],
      [MIG, high(PR[467].mergeSha)],
    ]);
    const b = { sha: PR[476].mergeSha, confidence: "high", why: "fails at …" };
    const v = verdict({
      ...base,
      failing,
      attribution,
      bisected: new Map([
        [OBS, b],
        [GRANT, b],
        [TRIG, b],
      ]),
    });
    expect(
      v.culprits.map((c: any) => [c.pr, c.confidence, c.files.length])
    ).toEqual([
      [476, "high", 3],
      [467, "high", 1],
    ]);
    expect(v.revertable).toBe(false);
    expect(v.why.join()).toContain("2 culprits");
  });

  it("one culprit explaining every failing file at high: revertable; medium, or a file left unexplained: not", () => {
    expect(one().revertable).toBe(true);
    expect(
      one({
        attribution: new Map([
          [
            MIG,
            { method: "reach", confidence: "medium", shas: [PR[467].mergeSha] },
          ],
        ]),
      }).revertable
    ).toBe(false);
    const loose = verdict({
      ...base,
      failing: [
        { file: MIG, kind: "lint" },
        { file: OBS, kind: "test" },
      ],
      attribution: new Map<string, any>([
        [MIG, high(PR[467].mergeSha)],
        [OBS, low([])],
      ]),
    });
    expect(loose.revertable).toBe(false);
    expect(loose.unattributed.map((u: any) => u.file)).toEqual([OBS]);
  });

  it("S6: a failed job that names no file (an audit, a Docker build) makes the red not revertable", () => {
    const v = one({ silentJobs: ["API e2e"] });
    expect(v.revertable).toBe(false);
    expect(v.why.join()).toContain("API e2e failed and named no file");
  });

  it("S14: never for a ratchet-baseline red (fixed / stale), never for a PR that adds a migration", () => {
    for (const kind of ["fixed", "stale"]) {
      const v = one({ failing: [{ file: MIG, kind }] });
      expect(v.revertable, kind).toBe(false);
      expect(v.why.join()).toContain("baseline red");
    }
    const m = one({
      candidates: candidates.map((c: any) => ({
        ...c,
        migration: c.pr === 467,
      })),
    });
    expect(m.revertable).toBe(false);
    expect(m.why.join()).toContain("adds a migration");
  });

  it("N7: no all-green main below the range: not revertable", () => {
    const v = one({ lastGreen: null });
    expect(v.revertable).toBe(false);
    expect(v.why.join()).toContain("no all-green main");
  });

  it("isFixMerge: a fix/main-red-* or revert merge, nothing else", () => {
    expect(
      isFixMerge(
        "Merge pull request #9 from Synap-core/fix/main-red-x\n\nfix: main red"
      )
    ).toBe(true);
    expect(
      isFixMerge(
        "Merge pull request #9 from Synap-core/fix/main-red-revert-1-abcdef12\n\nRevert #1: x"
      )
    ).toBe(true);
    expect(
      isFixMerge(
        'Merge pull request #9 from Synap-core/feat/x\n\nRevert "feat: y"'
      )
    ).toBe(true);
    expect(
      isFixMerge("Merge pull request #9 from Synap-core/feat/x\n\nfeat: x")
    ).toBe(false);
  });
});

// ── the revert rule ─────────────────────────────────────────────────────────
const NAMED = Date.parse("2026-10-29T01:50:00Z");
const MERGED = "2026-10-29T01:00:16Z";
function input(over: Record<string, any> = {}) {
  const culprit = {
    sha: PR[467].mergeSha,
    pr: 467,
    confidence: "high",
    files: [{ file: MIG, kind: "lint", confidence: "high", why: "own file" }],
    namedAt: iso(NAMED),
    namedFiles: [MIG],
  };
  return {
    now: NAMED + (GRACE_MINUTES + 1) * MIN,
    main: {
      latest: { conclusion: "failure", head_sha: sha("r") },
      fixRunning: false,
    },
    record: {
      revertable: true,
      why: [],
      lastGreen: REAL.lastGreen,
      culprits: [culprit],
    },
    culpritPr: {
      number: 467,
      title: "fix: automation run count backfill",
      head: "fix/automation-run-count-backfill",
      mergedAt: MERGED,
      mergeSha: PR[467].mergeSha,
      session: SESSION,
    },
    onMainLine: true,
    openPrs: [],
    priorReverts: [],
    branchExists: false,
    owners: { ok: true, sessions: [] },
    token: true,
    ...over,
  };
}

describe("revertDecision: the revert rule, row by row", () => {
  it("every condition holds: revert", () => {
    expect(revertDecision(input())).toMatchObject({
      revert: true,
      hold: null,
      reasons: [],
    });
  });

  it("the grace window: not before 30 min after the culprit was first named", () => {
    const early = revertDecision(
      input({ now: NAMED + (GRACE_MINUTES - 1) * MIN })
    );
    expect(early.revert).toBe(false);
    expect(early.reasons.join()).toContain("grace");
    expect(
      revertDecision(input({ now: NAMED + GRACE_MINUTES * MIN })).revert
    ).toBe(true);
  });

  it("an owner at work holds it: an active `main red: backend` session started after the merge", () => {
    const owner = {
      title: "main red: backend Full suite @4431d3ff",
      status: "active",
      startedAt: "2026-10-29T01:55:00Z",
    };
    const d = revertDecision(
      input({ owners: { ok: true, sessions: [owner] } })
    );
    expect(d).toMatchObject({ revert: false });
    expect(d.hold).toContain("main red: backend");
    // An owner of an OLDER red, still open, or a paused one, does not hold this red.
    expect(
      revertDecision(
        input({
          owners: {
            ok: true,
            sessions: [{ ...owner, startedAt: "2026-10-28T20:00:00Z" }],
          },
        })
      ).revert
    ).toBe(true);
    expect(
      revertDecision(
        input({
          owners: { ok: true, sessions: [{ ...owner, status: "paused" }] },
        })
      ).revert
    ).toBe(true);
  });

  it("an owner the bot cannot see is UNKNOWN, and an unknown owner holds it (a failed read is never nobody)", () => {
    const d = revertDecision(
      input({ owners: { ok: false, why: "the pod is not configured" } })
    );
    expect(d.revert).toBe(false);
    expect(d.hold).toContain("unknown");
  });

  it("a fix PR opened after the merge holds it: fix/main-red-*, or a PR from the culprit's session; older ones do not (S17)", () => {
    const fix = revertDecision(
      input({
        openPrs: [
          {
            number: 489,
            head: "fix/main-red-476-thread",
            body: "",
            createdAt: "2026-10-29T01:52:00Z",
          },
        ],
      })
    );
    expect(fix.revert).toBe(false);
    expect(fix.hold).toContain("#489");
    const stale = revertDecision(
      input({
        openPrs: [
          {
            number: 400,
            head: "fix/main-red-old",
            body: "",
            createdAt: "2026-10-27T10:00:00Z",
          },
        ],
      })
    );
    expect(stale.revert).toBe(true);
    const fromSession = revertDecision(
      input({
        openPrs: [
          {
            number: 490,
            head: "fix/run-count-lint",
            body: `Pod session: ${SESSION}`,
            createdAt: "2026-10-29T01:58:00Z",
          },
        ],
      })
    );
    expect(fromSession.hold).toContain("#490");
    expect(
      revertDecision(
        input({
          openPrs: [
            {
              number: 300,
              head: "feat/older",
              body: `Pod session: ${SESSION}`,
              createdAt: "2026-10-27T10:00:00Z",
            },
          ],
        })
      ).revert
    ).toBe(true);
  });

  it("no app token: never reverts, says what it would do", () => {
    const d = revertDecision(input({ token: false }));
    expect(d.revert).toBe(false);
    expect(d.reasons.join()).toContain("would revert");
  });

  it("S4: the record's commit must be the culprit PR's merge, on main's first-parent line", () => {
    expect(
      revertDecision(
        input({ culpritPr: { ...input().culpritPr, mergeSha: sha("9") } })
      ).reasons.join()
    ).toContain("is not #467's merge");
    expect(
      revertDecision(input({ onMainLine: false })).reasons.join()
    ).toContain("not on main's first-parent line");
  });

  it("never a revert of a revert; never two reverts for one red; never over an existing branch", () => {
    expect(
      revertDecision(
        input({
          culpritPr: { ...input().culpritPr, title: 'Revert "feat: x"' },
        })
      ).revert
    ).toBe(false);
    expect(
      revertDecision(
        input({
          culpritPr: {
            ...input().culpritPr,
            head: "fix/main-red-revert-466-abcdef12",
          },
        })
      ).revert
    ).toBe(false);
    const prior = {
      number: 500,
      head: "fix/main-red-revert-476-b22676ce",
      body: `Red-main-base: ${REAL.lastGreen}`,
      state: "closed",
    };
    expect(
      revertDecision(input({ priorReverts: [prior] })).reasons.join()
    ).toContain("already had its revert");
    const same = {
      number: 501,
      head: revertBranch(467, PR[467].mergeSha),
      body: "",
      state: "closed",
    };
    expect(
      revertDecision(input({ priorReverts: [same] })).reasons.join()
    ).toContain("already had its revert");
    expect(revertDecision(input({ branchExists: true })).revert).toBe(false);
  });

  it("main green, a newer FIX run still going, no record, a record that is not revertable, other files now: no revert", () => {
    expect(
      revertDecision(
        input({
          main: { latest: { conclusion: "success" }, fixRunning: false },
        })
      ).reasons
    ).toEqual(["main is green"]);
    expect(
      revertDecision(
        input({ main: { latest: { conclusion: "failure" }, fixRunning: true } })
      ).revert
    ).toBe(false);
    expect(revertDecision(input({ record: null })).revert).toBe(false);
    expect(
      revertDecision(
        input({
          record: { ...input().record, revertable: false, why: ["2 culprits"] },
        })
      ).reasons.join()
    ).toContain("2 culprits");
    const other = input();
    other.record.culprits[0].namedFiles = ["packages/c/src/other.test.ts"];
    expect(revertDecision(other).reasons.join()).toContain("no longer fail");
  });
});

// ── end to end: a fake GitHub, a fake pod, a fake shell ─────────────────────
type Call = { method: string; path: string; body?: any; token?: string };
function fakeGitHub(
  routes: Array<[RegExp, (m: RegExpExecArray, c: Call) => any]>
) {
  const calls: Call[] = [];
  return {
    calls,
    rest(path: string, opts: any = {}) {
      const call = {
        method: opts.method ?? "GET",
        path,
        body: opts.body,
        token: opts.token,
      };
      calls.push(call);
      for (const [re, fn] of routes) {
        const m = re.exec(`${call.method} ${path}`);
        if (m) return fn(m, call);
      }
      throw new Error(`gh api -X ${call.method} ${path}: Not Found (HTTP 404)`);
    },
  };
}
function fakePod(sessions: any = []) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({
      method: init.method,
      url,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const ok = (v: any) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(v),
    });
    if (/\/focus-sessions\?/.test(url)) return ok(sessions);
    if (/\/focus-sessions\//.test(url))
      return ok({ id: SESSION, channelId: "chan-1", userId: "user-1" });
    if (/\/threads\/chan-1\/messages$/.test(url)) return ok({ id: "m1" });
    return { ok: false, status: 404, text: async () => "no" };
  };
  return { calls, fetchImpl };
}
const POD_ENV = {
  SYNAP_POD_URL: "https://pod.example",
  SYNAP_OBS_KEY: "k",
  SYNAP_POD_WORKSPACE_ID: "ws-1",
};

describe("podClient.activeSessions: a reply that is not a list is an unknown owner, never an empty one", () => {
  it("a list: the sessions; an object, null or an error string at HTTP 200: THROWS", async () => {
    const ok = podClient(
      POD_ENV,
      fakePod([
        { title: "main red: backend x", status: "active", startedAt: "t" },
      ]).fetchImpl
    );
    expect(await ok.activeSessions()).toEqual([
      { title: "main red: backend x", status: "active", startedAt: "t" },
    ]);
    for (const body of [{ items: [] }, null, "oops"]) {
      const pod = podClient(POD_ENV, fakePod(body).fetchImpl);
      await expect(pod.activeSessions(), JSON.stringify(body)).rejects.toThrow(
        /not a list/
      );
    }
  });
});

/** The name flow for a red run whose range is #467's merge alone. */
function nameWorld() {
  const red = PR[467];
  const comments: any[] = [];
  const gh = fakeGitHub([
    [
      /^GET repos\/o\/r\/actions\/runs\/77$/,
      () => ({
        event: "push",
        head_branch: "main",
        head_sha: red.mergeSha,
        html_url: "https://ci/77",
      }),
    ],
    [
      /^GET repos\/o\/r\/actions\/runs\/77\/jobs/,
      () => ({
        jobs: [
          { id: 1, name: "Release gate: lint", conclusion: "failure" },
          { id: 2, name: "API e2e", conclusion: "success" },
        ],
      }),
    ],
    [/^GET repos\/o\/r\/actions\/jobs\/1\/logs$/, () => RELEASE_GATE_LOG],
    [
      /^GET repos\/o\/r\/pulls\/467\/files/,
      () => red.files.map((f: string) => ({ filename: f, status: "modified" })),
    ],
    [/^GET repos\/o\/r\/issues\/467\/comments/, () => comments],
    [
      /^POST repos\/o\/r\/issues\/467\/comments$/,
      (_m, c) => (
        comments.push({
          body: c.body.body,
          created_at: "2026-10-29T01:50:00Z",
        }),
        {}
      ),
    ],
    [
      /^GET repos\/o\/r\/pulls\/467$/,
      () => ({
        number: 467,
        title: red.title,
        head: { ref: red.head },
        body: `x\nPod session: ${SESSION}\n`,
        merged_at: red.mergedAt,
        merge_commit_sha: red.mergeSha,
        html_url: "https://gh/467",
      }),
    ],
    [/^POST repos\/o\/r\/check-runs$/, () => ({})],
  ]);
  const sh = (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "log")
      return {
        code: 0,
        out: `${red.mergeSha}\tMerge pull request #467 from Synap-core/${red.head}\n${REAL.lastGreen}\tMerge pull request #484 from x/y\n`,
      };
    return { code: 1, out: "unexpected" };
  };
  return { gh, sh, comments };
}
const lastGreenOnly = (c: string) => ({
  verdict: c === REAL.lastGreen ? "pass" : "fail",
});

describe("end to end: name and post", () => {
  it("a red run whose range is one PR: comments on it once, tells its pod session, writes the record", async () => {
    const { gh, sh, comments } = nameWorld();
    const pod = fakePod();
    const env = { GITHUB_REPOSITORY: "o/r", RUN_ID: "77", ...POD_ENV };
    const r: any = await main({
      argv: ["name"],
      env,
      gh,
      sh,
      fetchImpl: pod.fetchImpl,
      now: NAMED,
      log: () => {},
      root: REPO,
      readVerdict: lastGreenOnly,
    });
    expect(r.bisect).toBe(false);
    expect(comments).toHaveLength(1);
    expect(readMarker(comments[0].body)).toMatchObject({
      merge: PR[467].mergeSha,
      files: [MIG],
      namedAt: iso(NAMED),
    });
    expect(comments[0].body).toContain(revertBranch(467, PR[467].mergeSha));
    const post = pod.calls.find((c) => c.method === "POST");
    expect(pod.calls[0].url).toBe(
      `https://pod.example/api/hub/focus-sessions/${SESSION}`
    );
    expect(post?.url).toBe(
      "https://pod.example/api/hub/threads/chan-1/messages"
    );
    expect(post?.body).toMatchObject({ role: "assistant", userId: "user-1" });
    const rec = gh.calls.find(
      (c) => c.method === "POST" && c.path === "repos/o/r/check-runs"
    );
    expect(rec?.body).toMatchObject({
      name: RECORD_CHECK,
      head_sha: PR[467].mergeSha,
      conclusion: "neutral",
    });
    const record = readRecord(rec?.body.output.text);
    expect(record).toMatchObject({
      revertable: true,
      lastGreen: REAL.lastGreen,
      redSha: PR[467].mergeSha,
    });
    expect(record.culprits.map((c: any) => [c.pr, c.confidence])).toEqual([
      [467, "high"],
    ]);

    // A second red run of the same red: no second comment or room post; the
    // record keeps the FIRST naming time (the grace window does not restart).
    const before = pod.calls.length;
    await main({
      argv: ["name"],
      env,
      gh,
      sh,
      fetchImpl: pod.fetchImpl,
      now: NAMED + 20 * MIN,
      log: () => {},
      root: REPO,
      readVerdict: lastGreenOnly,
    });
    expect(comments).toHaveLength(1);
    expect(pod.calls.length).toBe(before);
    const second = gh.calls
      .filter((c) => c.method === "POST" && c.path === "repos/o/r/check-runs")
      .at(-1);
    expect(readRecord(second?.body.output.text).culprits[0].namedAt).toBe(
      iso(NAMED)
    );
  });

  it("S6 end to end: a failed job whose log names no file, beside a named lint red, makes it not revertable", async () => {
    const { gh, sh } = nameWorld();
    const jobs = gh.rest.bind(gh);
    const wrapped = {
      calls: gh.calls,
      rest(path: string, opts: any = {}) {
        if (/actions\/runs\/77\/jobs/.test(path))
          return {
            jobs: [
              { id: 1, name: "Release gate: lint", conclusion: "failure" },
              {
                id: 3,
                name: "Release gate: Docker image",
                conclusion: "failure",
              },
              { id: 4, name: "Release gate", conclusion: "failure" },
            ],
          };
        if (/actions\/jobs\/[34]\/logs/.test(path))
          return "ERROR: failed to build: exit code 1\n";
        return jobs(path, opts);
      },
    };
    await main({
      argv: ["name"],
      env: { GITHUB_REPOSITORY: "o/r", RUN_ID: "77" },
      gh: wrapped,
      sh,
      now: NAMED,
      log: () => {},
      root: REPO,
      readVerdict: lastGreenOnly,
    });
    const rec = readRecord(
      gh.calls
        .filter((c) => c.method === "POST" && c.path === "repos/o/r/check-runs")
        .at(-1)?.body.output.text
    );
    expect(rec.revertable).toBe(false);
    expect(rec.silentJobs).toEqual(["Release gate: Docker image"]); // the judge "Release gate" is not silent
  });

  it("the real 29 Oct red: every file goes to ONE bisect (the lint file with #467 as its hint), and nothing is posted yet", async () => {
    const red = PR[474];
    const line = [...REAL.prs]
      .reverse()
      .map(
        (p: any) =>
          `${p.mergeSha}\tMerge pull request #${p.number} from Synap-core/${p.head}`
      );
    const gh = fakeGitHub([
      [
        /^GET repos\/o\/r\/actions\/runs\/40797830929$/,
        () => ({
          event: "push",
          head_branch: "main",
          head_sha: red.mergeSha,
          html_url: "https://ci/40797830929",
        }),
      ],
      [
        /^GET repos\/o\/r\/actions\/runs\/40797830929\/jobs/,
        () => ({
          jobs: [
            { id: 1, name: "Release gate", conclusion: "failure" },
            { id: 2, name: "Full suite", conclusion: "failure" },
          ],
        }),
      ],
      [/^GET repos\/o\/r\/actions\/jobs\/1\/logs$/, () => RELEASE_GATE_LOG],
      [/^GET repos\/o\/r\/actions\/jobs\/2\/logs$/, () => FULL_SUITE_LOG],
      [
        /^GET repos\/o\/r\/pulls\/(\d+)\/files/,
        (m) =>
          PR[Number(m[1])].files.map((f: string) => ({
            filename: f,
            status: "modified",
          })),
      ],
    ]);
    const sh = () => ({
      code: 0,
      out: `${line.join("\n")}\n${REAL.lastGreen}\tMerge pull request #484 from x/y\n`,
    });
    const dir = mkdtempSync(join(tmpdir(), "culprit-"));
    try {
      const out = join(dir, "out");
      writeFileSync(out, "");
      const r: any = await main({
        argv: ["name"],
        env: {
          GITHUB_REPOSITORY: "o/r",
          RUN_ID: "40797830929",
          GITHUB_OUTPUT: out,
        },
        gh,
        sh,
        now: NAMED,
        log: () => {},
        root: REPO,
        readVerdict: lastGreenOnly,
      });
      expect(r.bisect).toBe(true);
      expect(r.plan.candidates.map((c: any) => c.pr)).toEqual([
        465, 467, 476, 470, 475, 474,
      ]);
      expect(r.plan.bisect).toEqual([MIG, OBS, GRANT, TRIG]);
      expect(r.plan.hints).toEqual({ [MIG]: PR[467].mergeSha });
      const o = readFileSync(out, "utf8");
      expect(o).toContain("bisect<<__CULPRIT__\ntrue\n__CULPRIT__");
      expect(
        JSON.parse(/plan<<__CULPRIT__\n(.*)\n__CULPRIT__/.exec(o)![1]).bisect
      ).toEqual([MIG, OBS, GRANT, TRIG]);
      expect(gh.calls.filter((c) => c.method !== "GET")).toEqual([]);

      // post: main's finder, the plan from name, the bisect's result (checked).
      const posts = fakeGitHub([
        [/^GET repos\/o\/r\/issues\/\d+\/comments/, () => []],
        [/^POST repos\/o\/r\/issues\/(\d+)\/comments$/, () => ({})],
        [
          /^GET repos\/o\/r\/pulls\/(\d+)$/,
          (m) => ({
            number: Number(m[1]),
            body: "",
            html_url: `https://gh/${m[1]}`,
          }),
        ],
        [/^POST repos\/o\/r\/check-runs$/, () => ({})],
      ]);
      const b476 = {
        sha: PR[476].mergeSha,
        confidence: "high",
        why: "bisect: …",
      };
      const result = {
        bisected: {
          [OBS]: b476,
          [GRANT]: b476,
          [TRIG]: b476,
          [MIG]: {
            sha: PR[467].mergeSha,
            confidence: "high",
            why: "bisect: …",
          },
        },
      };
      const rec: any = await main({
        argv: ["post"],
        env: {
          GITHUB_REPOSITORY: "o/r",
          PLAN: JSON.stringify(r.plan),
          RESULT: JSON.stringify(result),
        },
        gh: posts,
        now: NAMED,
        log: () => {},
      });
      expect(rec.culprits.map((c: any) => c.pr)).toEqual([467, 476]);
      expect(rec.revertable).toBe(false);
      expect(
        posts.calls
          .filter(
            (c) => c.method === "POST" && /issues\/\d+\/comments/.test(c.path)
          )
          .map((c) => c.path)
      ).toEqual([
        "repos/o/r/issues/467/comments",
        "repos/o/r/issues/476/comments",
      ]);
      // No bisect result (the job failed): the mapping's verdict still posts.
      const none: any = await main({
        argv: ["post"],
        env: {
          GITHUB_REPOSITORY: "o/r",
          PLAN: JSON.stringify(r.plan),
          RESULT: "",
        },
        gh: posts,
        now: NAMED,
        log: () => {},
      });
      expect(none.revertable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/** The sweep's world: main red at the record's commit, the culprit #467. */
function sweepWorld(
  over: {
    record?: any;
    sessions?: any;
    openPrs?: any[];
    recordWorkflow?: string;
    runs?: any[];
  } = {}
) {
  const red = PR[467];
  const latest = sha("e");
  const culprit = {
    sha: red.mergeSha,
    pr: 467,
    confidence: "high",
    files: [
      {
        file: MIG,
        kind: "lint",
        confidence: "high",
        why: "the only PR in the range that changed this file",
      },
    ],
    namedAt: iso(NAMED),
    namedFiles: [MIG],
  };
  const record = over.record ?? {
    v: 1,
    redSha: latest,
    runUrl: "https://ci/77",
    lastGreen: REAL.lastGreen,
    culprits: [culprit],
    unattributed: [],
    revertable: true,
    why: [],
  };
  const comments: any[] = [];
  const gh = fakeGitHub([
    [
      /^GET repos\/o\/r\/actions\/workflows\/ci\.yml\/runs/,
      () => ({
        workflow_runs: over.runs ?? [
          {
            status: "completed",
            conclusion: "failure",
            head_sha: latest,
            created_at: "2026-10-29T01:10:00Z",
          },
        ],
      }),
    ],
    [
      /^GET repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/,
      () => ({
        check_runs: [
          {
            name: RECORD_CHECK,
            check_suite: { id: 55 },
            output: { text: recordText(record) },
          },
        ],
      }),
    ],
    [
      /^GET repos\/o\/r\/actions\/runs\?check_suite_id=55$/,
      () => ({
        workflow_runs: [
          { path: over.recordWorkflow ?? RECORD_WORKFLOW, head_branch: "main" },
        ],
      }),
    ],
    [
      /^GET repos\/o\/r\/pulls\/467$/,
      () => ({
        number: 467,
        title: red.title,
        head: { ref: red.head },
        body: `Pod session: ${SESSION}`,
        merged_at: red.mergedAt,
        merge_commit_sha: red.mergeSha,
        html_url: "https://gh/467",
      }),
    ],
    [/^GET repos\/o\/r\/pulls\?state=open/, () => over.openPrs ?? []],
    [/^GET repos\/o\/r\/pulls\?state=all/, () => []],
    [/^GET repos\/o\/r\/issues\/467\/comments/, () => comments],
    [
      /^POST repos\/o\/r\/issues\/467\/comments$/,
      (_m, c) => (comments.push({ body: c.body.body }), {}),
    ],
    [
      /^POST repos\/o\/r\/pulls$/,
      () => ({ number: 999, html_url: "https://gh/999" }),
    ],
  ]);
  const git: string[][] = [];
  const sh = (cmd: string, args: string[]) => {
    if (cmd === "git") git.push(args);
    if (args[0] === "rev-list")
      return { code: 0, out: `${red.mergeSha} ${sha("1")} ${sha("2")}\n` };
    if (args[0] === "log")
      return {
        code: 0,
        out: `${latest}\n${red.mergeSha}\n${PR[465].mergeSha}\n`,
      };
    return { code: 0, out: "" };
  };
  const pod = fakePod(over.sessions ?? []);
  return { gh, sh, git, comments, pod };
}
const sweepEnv = (token = "app-tok") => ({
  GITHUB_REPOSITORY: "o/r",
  REVERT_TOKEN: token,
  ...POD_ENV,
});
const pushes = (git: string[][]) => git.filter((a) => a.includes("push"));
const sweepAt = (
  w: any,
  minutes: number,
  env: any = sweepEnv(),
  log: (l: string) => void = () => {}
) =>
  main({
    argv: ["sweep"],
    env,
    gh: w.gh,
    sh: w.sh,
    fetchImpl: w.pod.fetchImpl,
    now: NAMED + minutes * MIN,
    log,
  }) as any;

describe("end to end: sweep", () => {
  it("30 min after naming, still red, nobody owns it: pushes ONLY the revert branch and opens the PR with the app token", async () => {
    const w = sweepWorld();
    const d = await sweepAt(w, 31);
    expect(d.revert).toBe(true);
    const branch = revertBranch(467, PR[467].mergeSha);
    expect(branch).toMatch(REVERT_BRANCH_RE);
    expect(w.git.find((a) => a[0] === "revert")).toEqual([
      "revert",
      "--no-commit",
      "-m",
      "1",
      PR[467].mergeSha,
    ]);
    const p = pushes(w.git);
    expect(p).toHaveLength(1);
    expect(p[0].at(-1)).toBe(`HEAD:refs/heads/${branch}`);
    for (const a of p)
      for (const arg of a)
        expect(arg).not.toMatch(/(^|:)(refs\/heads\/)?main$/);
    expect(p[0].find((a) => a.startsWith("https://"))).toBe(
      "https://github.com/o/r.git"
    );
    const pr = w.gh.calls.find(
      (c) => c.method === "POST" && c.path === "repos/o/r/pulls"
    );
    expect(pr?.token).toBe("app-tok");
    expect(pr?.body).toMatchObject({
      head: branch,
      base: "main",
      draft: false,
    });
    for (const s of [
      `Pod session: ${SESSION}`,
      "founder decision 0b4db9f7",
      `Red-main-base: ${REAL.lastGreen}`,
      MIG,
    ])
      expect(pr?.body.body).toContain(s);
    // The prior-revert read asks for THIS branch, in any state.
    expect(
      w.gh.calls.some(
        (c) =>
          c.path.includes(`head=${encodeURIComponent(`o:${branch}`)}`) &&
          c.path.includes("state=all")
      )
    ).toBe(true);
  });

  it("S4: a record posted by any other workflow is ignored, so nothing is reverted", async () => {
    const w = sweepWorld({ recordWorkflow: ".github/workflows/evil.yml" });
    const logs: string[] = [];
    const d = await sweepAt(w, 45, sweepEnv(), (l) => logs.push(l));
    expect(d.revert).toBe(false);
    expect(d.reasons.join()).toContain("no culprit record");
    expect(logs.join("\n")).toContain(
      "is not from .github/workflows/red-main.yml on main"
    );
    expect(pushes(w.git)).toEqual([]);
    expect(recordOf(sweepWorld().gh, "o/r", sha("e"))).not.toBeNull();
  });

  it("S7: a newer running main run holds it only when it is a main-red fix or a revert", async () => {
    const red = {
      status: "completed",
      conclusion: "failure",
      head_sha: sha("e"),
      created_at: "2026-10-29T01:10:00Z",
    };
    const busy = {
      status: "in_progress",
      created_at: "2026-10-29T02:30:00Z",
      head_commit: {
        message: "Merge pull request #520 from Synap-core/feat/x\n\nfeat: x",
      },
    };
    expect((await sweepAt(sweepWorld({ runs: [busy, red] }), 45)).revert).toBe(
      true
    );
    const fix = {
      ...busy,
      head_commit: {
        message:
          "Merge pull request #521 from Synap-core/fix/main-red-lint\n\nfix: main red",
      },
    };
    const w = sweepWorld({ runs: [fix, red] });
    expect((await sweepAt(w, 45)).revert).toBe(false);
    expect(pushes(w.git)).toEqual([]);
  });

  it("before the grace window ends: nothing is written", async () => {
    const w = sweepWorld();
    const d = await sweepAt(w, 10);
    expect(d.revert).toBe(false);
    expect(w.git.filter((a) => a[0] !== "log")).toEqual([]);
    expect(w.gh.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("an owner at work (a `main red: backend` session): no revert, says so ONCE on the culprit PR", async () => {
    const w = sweepWorld({
      sessions: [
        {
          title: "main red: backend Release gate @86d87b77",
          status: "active",
          startedAt: "2026-10-29T01:52:00Z",
        },
      ],
    });
    expect((await sweepAt(w, 45)).revert).toBe(false);
    await sweepAt(w, 55);
    expect(pushes(w.git)).toEqual([]);
    expect(w.comments).toHaveLength(1);
    expect(w.comments[0].body).toContain("held");
  });

  it("the pod answers 200 with a non-list: the owner is unknown, so no revert", async () => {
    const w = sweepWorld({ sessions: { error: "rate limited" } });
    const d = await sweepAt(w, 45);
    expect(d.revert).toBe(false);
    expect(d.hold).toContain("unknown");
  });

  it("an open fix/main-red-* PR opened after the merge: no revert", async () => {
    const w = sweepWorld({
      openPrs: [
        {
          number: 489,
          state: "open",
          head: { ref: "fix/main-red-run-count-lint" },
          body: "",
          created_at: "2026-10-29T01:52:00Z",
        },
      ],
    });
    const d = await sweepAt(w, 45);
    expect(d.revert).toBe(false);
    expect(d.hold).toContain("#489");
    expect(pushes(w.git)).toEqual([]);
  });

  it("no app token (the secrets unset): logs what it would do, pushes nothing, opens nothing", async () => {
    const w = sweepWorld();
    const logs: string[] = [];
    const d = await sweepAt(w, 45, sweepEnv(""), (l) => logs.push(l));
    expect(d.revert).toBe(false);
    expect(logs.join("\n")).toContain("would revert");
    expect(pushes(w.git)).toEqual([]);
    expect(w.gh.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("no pod configured: the owner is unknown, so no revert", async () => {
    const w = sweepWorld();
    const d = (await main({
      argv: ["sweep"],
      env: { GITHUB_REPOSITORY: "o/r", REVERT_TOKEN: "app-tok" },
      gh: w.gh,
      sh: w.sh,
      now: NAMED + 45 * MIN,
      log: () => {},
    })) as any;
    expect(d.revert).toBe(false);
    expect(d.hold).toContain("unknown");
    expect(pushes(w.git)).toEqual([]);
  });

  it("a revert that conflicts with main: aborted, said once, no push", async () => {
    const w = sweepWorld();
    const sh = (cmd: string, args: string[]) =>
      args[0] === "revert" && args[1] === "--no-commit"
        ? (w.git.push(args), { code: 1, out: "CONFLICT" })
        : w.sh(cmd, args);
    await main({
      argv: ["sweep"],
      env: sweepEnv(),
      gh: w.gh,
      sh,
      fetchImpl: w.pod.fetchImpl,
      now: NAMED + 45 * MIN,
      log: () => {},
    });
    expect(w.git.some((a) => a[0] === "revert" && a[1] === "--abort")).toBe(
      true
    );
    expect(pushes(w.git)).toEqual([]);
    expect(w.comments[0].body).toContain("conflicts");
  });
});

describe("the wire and the workflow", () => {
  it("ghTransport through a fake `gh` binary: method, body on stdin, the token per call", () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    try {
      const fake = join(dir, "gh");
      writeFileSync(
        fake,
        `#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({argv:process.argv.slice(2),stdin:s,token:process.env.GH_TOKEN})));\n`
      );
      chmodSync(fake, 0o755);
      const gh = ghTransport({
        ghBin: fake,
        env: { ...process.env, GH_TOKEN: "job-token" },
      });
      const out = gh.rest("repos/o/r/pulls", {
        method: "POST",
        body: { head: "x" },
        token: "app-tok",
      });
      expect(out.argv).toEqual([
        "api",
        "-X",
        "POST",
        "repos/o/r/pulls",
        "--input",
        "-",
      ]);
      expect(JSON.parse(out.stdin)).toEqual({ head: "x" });
      expect(out.token).toBe("app-tok");
      expect(gh.rest("repos/o/r").token).toBe("job-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ghTransport reads a job log that carries terminal escape sequences, on a new gh and an old one", () => {
    // A new gh refuses escapes without --allow-escape-sequences; an old gh
    // rejects that flag. The log text must come back either way.
    // The shape of run 40930185444's Full suite log: timestamped, colours on
    // the vitest lines, the ratchet's list plain.
    const LOG = [
      "2026-10-29T19:07:20.0000000Z \u001b[31m FAIL \u001b[39m a/b.test.ts > x",
      "2026-10-29T19:07:26.2125347Z   [new-failure]",
      "2026-10-29T19:07:26.2127262Z       a/b.test.ts",
      "",
    ].join("\n");
    const fakes = {
      newGh: `const a=process.argv.slice(2);if(a.includes("--allow-escape-sequences")){process.stdout.write(${JSON.stringify(LOG)})}else{console.error("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway");process.exit(1)}`,
      oldGh: `const a=process.argv.slice(2);if(a.includes("--allow-escape-sequences")){console.error("unknown flag: --allow-escape-sequences");process.exit(1)}process.stdout.write(${JSON.stringify(LOG)})`,
    };
    for (const [name, body] of Object.entries(fakes)) {
      const dir = mkdtempSync(join(tmpdir(), `fake-gh-${name}-`));
      try {
        const fake = join(dir, "gh");
        writeFileSync(fake, `#!/usr/bin/env node\n${body}\n`);
        chmodSync(fake, 0o755);
        const gh = ghTransport({ ghBin: fake });
        const text = gh.rest("repos/o/r/actions/jobs/1/logs", { raw: true });
        expect(text, name).toBe(LOG);
        expect(
          failingFiles(text).map((f: { file: string }) => f.file),
          name
        ).toEqual(["a/b.test.ts"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  const wf = readFileSync(join(REPO, RECORD_WORKFLOW), "utf8");
  const jobsText = wf.slice(wf.indexOf("\njobs:\n"));
  /** One job's block (two-space-indented key under `jobs:`). */
  const job = (name: string) => {
    const m = new RegExp(
      `\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`
    ).exec(jobsText);
    expect(m, name).toBeTruthy();
    return m![1];
  };

  it("red-main.yml: names on a FAILED push run of CI on main, sweeps on a schedule", () => {
    expect(wf).toMatch(
      /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/
    );
    expect(wf).toMatch(/schedule:\n\s+- cron: "[^"]+"/);
    expect(wf).not.toMatch(/^\s*pull_request:/m);
    for (const s of [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.conclusion == 'failure'",
    ])
      expect(job("name")).toContain(s);
  });

  it("the merge bot app's secrets: only in jobs of environment ci-bots; the probe job holds no token and no pod secret", () => {
    const jobs = [...jobsText.matchAll(/\n {2}([a-z-]+):\n/g)].map((m) => m[1]);
    expect(jobs).toEqual(["name", "bisect", "post", "sweep"]); // non-vacuity: every job is looked at
    for (const name of jobs) {
      const body = job(name);
      if (/SYNAP_MERGE_BOT_/.test(body))
        expect(body, name).toMatch(/\n {4}environment: ci-bots\n/);
    }
    expect(job("sweep")).toContain("SYNAP_MERGE_BOT_KEY");
    const probe = job("bisect");
    expect(probe).toMatch(/permissions:\n {6}contents: read\n(?! {6}\w)/);
    for (const s of [
      "GH_TOKEN",
      "SYNAP_OBS_KEY",
      "SYNAP_POD_URL",
      "SYNAP_MERGE_BOT",
      "github.token",
    ])
      expect(probe, s).not.toContain(s);
    // The post job runs main's finder, never the bisect job's copy.
    expect(job("post")).toContain("node scripts/ci/culprit-finder.mjs post");
    expect(job("post")).not.toContain("RUNNER_TEMP");
  });

  it("the bisect job copies every module the finder imports (derived from its imports, so a new one joins by existing)", () => {
    const seen = new Set<string>();
    const walk = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const text = readFileSync(join(REPO, rel), "utf8");
      for (const m of text.matchAll(/from "(\.\.?\/[^"]+\.mjs)"/g))
        walk(join(rel, "..", m[1]).replaceAll("\\", "/"));
    };
    walk("scripts/ci/culprit-finder.mjs");
    expect(seen.size).toBeGreaterThanOrEqual(5); // non-vacuity: the finder, affected, release-gate-wait, tripwire-discovery, pod-observation
    const copied = [...wf.matchAll(/^\s+cp ([^\n]+)$/gm)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((x) => x.endsWith(".mjs"));
    expect(copied.sort()).toEqual([...seen].sort());
  });

  it("the probes build what CI builds: the composite action's --filter list, read from it", () => {
    const filters = buildFilters(
      readFileSync(
        join(REPO, ".github/actions/monorepo-setup/action.yml"),
        "utf8"
      )
    );
    expect(filters.length).toBeGreaterThanOrEqual(5);
    expect(filters).toContain("@synap/api");
  });

  it("a revert branch jumps as a main-red fix (merge-bot.mjs, backend#508: /^fix\\/main-red-/)", () => {
    expect(revertBranch(467, PR[467].mergeSha)).toMatch(FIX_BRANCH_RE);
    expect(revertBranch(467, PR[467].mergeSha)).toMatch(/^fix\/main-red-/);
  });
});
