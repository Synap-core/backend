/**
 * The layout resolver (scripts/layout/layout.mjs) and its hold (hold.mjs).
 *
 * A wrong "landed" lets a change merge before what it depends on, and a
 * second copy of the layout is the drift R8 counted five of. So this file pins:
 *   - the Depends-On grammar, and that every line it cannot read HOLDS;
 *   - the landed / waiting / blocked rules, and that a failed read never lands;
 *   - the check run each verdict posts;
 *   - that the callers in this repo use the resolver, not a copy of it;
 *   - that the hold runs the default branch's code, never the PR's.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` and the Full suite run it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import * as L from "./layout.mjs";
// @ts-expect-error — plain ESM script, no declarations
import * as H from "./hold.mjs";
import { SIBLINGS } from "../sibling-checkout.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(`${REPO}/${p}`, "utf8");
const layout = L.loadLayout();

type Pull = {
  state?: string;
  merged_at?: string | null;
  base?: { ref: string };
  mergeable?: boolean | null;
  draft?: boolean;
};

/** A GitHub client over fixed answers; a missing answer is a 404. */
function fakeGh({
  pulls = {} as Record<string, Pull>,
  shas = {} as Record<string, string>,
  compare = {} as Record<string, string>,
  failAll = false,
} = {}) {
  const miss = (what: string) => {
    const e = new Error(`${what}: HTTP 404`) as Error & { status: number };
    e.status = failAll ? 500 : 404;
    if (failAll) e.message = `${what}: HTTP 500`;
    return e;
  };
  return {
    pull: async (repo: string, n: number) => {
      if (failAll || !pulls[`${repo}#${n}`]) throw miss(`${repo}#${n}`);
      return pulls[`${repo}#${n}`];
    },
    commitSha: async (repo: string, ref: string) => {
      if (failAll || !shas[`${repo}@${ref}`]) throw miss(`${repo}@${ref}`);
      return shas[`${repo}@${ref}`];
    },
    compare: async (repo: string, base: string, head: string) => {
      if (failAll) throw miss("compare");
      return { status: compare[`${repo}:${head}`] ?? "ahead", ahead_by: 2 };
    },
  };
}

const parse = (text: string, self: string | null = null) =>
  L.parseDependsOn(text, { self, layout });

describe("Depends-On grammar", () => {
  it("reads every form, under any of a repo's names", () => {
    const { deps, errors } = parse(
      [
        "Intro text.",
        "Depends-On: backend#311",
        "depends-on: Synap-core/app-bases#105",
        "Depends-On: https://github.com/Synap-core/relay-app/pull/47",
        "Depends-On: synap-app@1a2b3c4d5e6f",
        "  Depends-On: relay@feat/make-them-goals",
      ].join("\n")
    );
    expect(errors).toEqual([]);
    expect(deps.map((d: any) => [d.dir, d.kind, d.number ?? d.ref])).toEqual([
      ["synap-backend", "pr", 311],
      ["synap-app", "pr", 105],
      ["relay-app", "pr", 47],
      ["synap-app", "ref", "1a2b3c4d5e6f"],
      ["relay-app", "ref", "feat/make-them-goals"],
    ]);
    expect(deps[1].repo).toBe("Synap-core/app-bases");
  });

  it("resolves `#n` to the repo it is written in, and refuses it with no repo", () => {
    expect(parse("Depends-On: #12", "backend").deps[0]).toMatchObject({
      dir: "synap-backend",
      number: 12,
    });
    expect(parse("Depends-On: #12").errors).toHaveLength(1);
  });

  it("ignores lines inside a fence: documenting the syntax declares nothing", () => {
    const { deps, errors } = parse(
      "```\nDepends-On: backend#1\n```\n~~~\nDepends-On: nope#2\n~~~"
    );
    expect(deps).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("turns every line it cannot read into an error, never into nothing", () => {
    const { deps, errors } = parse(
      [
        "Depends-On: foo#2",
        "Depends-On: backend#1 app-bases#2",
        "Depends-On:",
        "Depends-On: backend",
      ].join("\n")
    );
    expect(deps).toEqual([]);
    expect(errors).toHaveLength(4);
  });

  it("counts a dependency once", () => {
    expect(
      parse("Depends-On: backend#3\nDepends-On: synap-backend#3").deps
    ).toHaveLength(1);
  });

  it("only matches at the start of a line (prose mentioning it is not a line)", () => {
    expect(parse("We could write `Depends-On: backend#3` here.").deps).toEqual(
      []
    );
  });
});

describe("Companion: the dependent change that lands AFTER this one", () => {
  const companions = (text: string) =>
    L.companionRefs(
      L.parseCompanions(text, { self: "synap-backend", layout }),
      {
        exclude: ["synap-backend"],
      }
    );

  it("reads a branch, a commit and a pull request (its head)", () => {
    expect([
      ...companions(
        [
          "Companion: app-bases@fix/new-filter-field",
          "companion: relay@1a2b3c4d5e6f",
          "Companion: Synap-core/browser#88",
        ].join("\n")
      ),
    ]).toEqual([
      ["synap-app", "fix/new-filter-field"],
      ["relay-app", "1a2b3c4d5e6f"],
      ["browser", "refs/pull/88/head"],
    ]);
  });

  it("is not a Depends-On, and a Depends-On is not a companion", () => {
    const text = "Depends-On: app-bases#105\nCompanion: browser@feat/x";
    expect(parse(text).deps.map((d: { label: string }) => d.label)).toEqual([
      "app-bases#105",
    ]);
    expect([...companions(text)]).toEqual([["browser", "feat/x"]]);
  });

  it("ignores a fenced example and returns none when there is none", () => {
    expect(companions("```\nCompanion: app-bases@x\n```").size).toBe(0);
    expect(companions("no lines").size).toBe(0);
  });

  it("fails on a line it cannot read: a bad companion is never read as none", () => {
    for (const bad of [
      "Companion: app-bases feat/x",
      "Companion: nowhere@feat/x",
      "Companion: app-bases@--upload-pack=x",
      "Companion: app-bases@a\nCompanion: app@b",
    ])
      expect(() => companions(bad), bad).toThrow();
  });
});

describe("landed, waiting, blocked", () => {
  const dep = (text: string) => parse(text).deps[0];
  const BE = "Synap-core/backend";

  it("a PR merged into main has landed", async () => {
    const gh = fakeGh({
      pulls: {
        [`${BE}#1`]: { state: "closed", merged_at: "t", base: { ref: "main" } },
      },
    });
    expect(
      (await L.evaluateDependency(dep("Depends-On: backend#1"), gh)).status
    ).toBe("landed");
  });

  it("a PR merged into another base has NOT landed (a stacked base that never reached main)", async () => {
    const gh = fakeGh({
      pulls: {
        [`${BE}#1`]: {
          state: "closed",
          merged_at: "t",
          base: { ref: "feat/x" },
        },
      },
    });
    expect(
      (await L.evaluateDependency(dep("Depends-On: backend#1"), gh)).status
    ).toBe("blocked");
  });

  it("an open PR waits, and is tested as GitHub's test merge (its head when it conflicts)", async () => {
    const open = (mergeable: boolean | null) =>
      fakeGh({
        pulls: {
          [`${BE}#1`]: {
            state: "open",
            merged_at: null,
            base: { ref: "main" },
            mergeable,
          },
        },
      });
    const ok = await L.evaluateDependency(
      dep("Depends-On: backend#1"),
      open(true)
    );
    expect(ok).toMatchObject({
      status: "waiting",
      testRef: "refs/pull/1/merge",
    });
    const conflict = await L.evaluateDependency(
      dep("Depends-On: backend#1"),
      open(false)
    );
    expect(conflict).toMatchObject({
      status: "waiting",
      testRef: "refs/pull/1/head",
    });
  });

  it("a PR closed without merging can never land", async () => {
    const gh = fakeGh({
      pulls: {
        [`${BE}#1`]: {
          state: "closed",
          merged_at: null,
          base: { ref: "main" },
        },
      },
    });
    expect(
      (await L.evaluateDependency(dep("Depends-On: backend#1"), gh)).status
    ).toBe("blocked");
  });

  it("a commit has landed when it is on main, and waits (tested at itself) when not", async () => {
    const AB = "Synap-core/app-bases";
    const gh = fakeGh({
      shas: {
        [`${AB}@aaaa111`]: "a".repeat(40),
        [`${AB}@bbbb222`]: "b".repeat(40),
      },
      compare: {
        [`${AB}:${"a".repeat(40)}`]: "behind",
        [`${AB}:${"b".repeat(40)}`]: "diverged",
      },
    });
    expect(
      (await L.evaluateDependency(dep("Depends-On: app-bases@aaaa111"), gh))
        .status
    ).toBe("landed");
    expect(
      await L.evaluateDependency(dep("Depends-On: app-bases@bbbb222"), gh)
    ).toMatchObject({
      status: "waiting",
      testRef: "b".repeat(40),
    });
  });

  it("a repo that lands on another branch (synap-bridge: master) is judged against that branch", async () => {
    const SB = "Synap-core/synap-bridge";
    const bases: string[] = [];
    const gh = {
      ...fakeGh({
        pulls: {
          [`${SB}#1`]: {
            state: "closed",
            merged_at: "t",
            base: { ref: "master" },
          },
          [`${SB}#2`]: {
            state: "closed",
            merged_at: "t",
            base: { ref: "main" },
          },
        },
        shas: { [`${SB}@cccc333`]: "c".repeat(40) },
      }),
      compare: async (_repo: string, base: string) => {
        bases.push(base);
        return { status: "behind", ahead_by: 0 };
      },
    };
    const bridge = (n: string) =>
      L.evaluateDependency(dep(`Depends-On: bridge${n}`), gh);
    expect((await bridge("#1")).status).toBe("landed");
    expect((await bridge("#2")).status).toBe("blocked");
    expect((await bridge("@cccc333")).status).toBe("landed");
    expect(bases).toEqual(["master"]);
    // and a repo with no branch of its own keeps the layout's
    expect(dep("Depends-On: backend#1").defaultBranch).toBeUndefined();
  });

  it("a commit or branch that does not exist can never land", async () => {
    expect(
      (
        await L.evaluateDependency(
          dep("Depends-On: app-bases@cccc333"),
          fakeGh()
        )
      ).status
    ).toBe("blocked");
  });

  it("a FAILED read holds: it is never taken for a landed dependency", async () => {
    for (const line of [
      "Depends-On: backend#1",
      "Depends-On: app-bases@aaaa111",
    ]) {
      const r = await L.evaluateDependency(
        dep(line),
        fakeGh({ failAll: true })
      );
      expect(r.status).toBe("waiting");
      expect(r.detail).toContain("could not read");
    }
  });

  it("one verdict: any blocked > any waiting > landed; no dependency is landed", () => {
    const r = (status: string) => ({
      status,
      dep: {},
      testRef: null,
      detail: "",
    });
    expect(L.verdictOf([])).toBe("landed");
    expect(L.verdictOf([r("landed"), r("waiting")])).toBe("waiting");
    expect(L.verdictOf([r("waiting"), r("blocked")])).toBe("blocked");
  });

  it("parse errors are blocked results, so the hold fails on them", async () => {
    const results = await L.evaluateAll(parse("Depends-On: foo#2"), fakeGh());
    expect(L.verdictOf(results)).toBe("blocked");
  });

  it("lane refs: one test ref per waiting repo, the caller's own repo excluded", () => {
    const w = (dir: string, testRef: string) => ({
      status: "waiting",
      testRef,
      dep: { dir },
      detail: "",
    });
    const refs = L.laneRefs(
      [
        w("synap-app", "refs/pull/2/merge"),
        w("synap-backend", "refs/pull/9/merge"),
      ],
      {
        exclude: ["synap-backend"],
      }
    );
    expect([...refs]).toEqual([["synap-app", "refs/pull/2/merge"]]);
    expect(() =>
      L.laneRefs([w("synap-app", "x"), w("synap-app", "y")])
    ).toThrow(/one test ref per repo/);
  });
});

describe("sources a direct-commit repo declares its dependencies in", () => {
  it("reads the trailers of every commit beyond main, and refuses a list GitHub cut", async () => {
    const gh = {
      compare: async () => ({
        total_commits: 2,
        commits: [
          { commit: { message: "feat: x\n\nDepends-On: backend#311" } },
          { commit: { message: "fix: y" } },
        ],
      }),
    };
    const text = await L.commitMessages(gh, "Synap-core/relay-app", "feat/x");
    expect(parse(text).deps.map((d: any) => d.label)).toEqual(["backend#311"]);
    const cut = { compare: async () => ({ total_commits: 300, commits: [] }) };
    await expect(
      L.commitMessages(cut, "Synap-core/relay-app", "feat/x")
    ).rejects.toThrow(/300 commits ahead/);
  });

  it("turns relay's monorepo.json pins into commit dependencies", async () => {
    const manifest = {
      repos: [
        { dir: "synap-app", repo: "Synap-core/app-bases", ref: "a".repeat(40) },
        {
          dir: "synap-backend",
          repo: "Synap-core/backend",
          ref: "b".repeat(40),
        },
      ],
    };
    const gh = {
      get: async (_repo: string, path: string) => {
        expect(path).toBe("/contents/monorepo.json?ref=feat%2Fx");
        return {
          content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
        };
      },
    };
    const { deps, errors } = parse(
      await L.pinsText(gh, "Synap-core/relay-app", "feat/x")
    );
    expect(errors).toEqual([]);
    expect(deps.map((d: any) => [d.dir, d.kind, d.ref])).toEqual([
      ["synap-app", "ref", "a".repeat(40)],
      ["synap-backend", "ref", "b".repeat(40)],
    ]);
  });
});

describe("the check run each verdict posts", () => {
  const r = (status: string, label = "backend#1") => ({
    status,
    dep: { label },
    testRef: null,
    detail: "d",
  });

  it("success with no dependency, in progress while waiting, failure when blocked", () => {
    expect(H.checkFor([])).toMatchObject({
      status: "completed",
      conclusion: "success",
      title: "No dependencies",
    });
    expect(H.checkFor([r("landed")])).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    const waiting = H.checkFor([r("landed", "a#1"), r("waiting", "b#2")]);
    expect(waiting).toMatchObject({
      status: "in_progress",
      title: "Waiting for b#2",
    });
    expect(waiting.conclusion).toBeUndefined();
    expect(H.checkFor([r("waiting"), r("blocked", "c#3")])).toMatchObject({
      status: "completed",
      conclusion: "failure",
      title: "Cannot land: c#3",
    });
  });

  it("posts only on a change of state", () => {
    const want = H.checkFor([r("waiting")]);
    expect(H.sameCheck(null, want)).toBe(false);
    expect(
      H.sameCheck(
        {
          status: "in_progress",
          conclusion: null,
          output: { title: want.title },
        },
        want
      )
    ).toBe(true);
    expect(
      H.sameCheck(
        {
          status: "completed",
          conclusion: "success",
          output: { title: want.title },
        },
        want
      )
    ).toBe(false);
  });

  it("reads the PR number of a merge-queue branch, and nothing else", () => {
    expect(H.queuePrNumber("gh-readonly-queue/main/pr-438-0123abcd")).toBe(438);
    expect(H.queuePrNumber("feat/pr-438-x")).toBeNull();
  });
});

describe("one layout, one resolver", () => {
  it("layout.json: every layout names known repos, every repo its own override variable", () => {
    const envs = Object.values(layout.repos).map((r: any) => r.env);
    expect(new Set(envs).size).toBe(envs.length);
    for (const def of Object.values(layout.layouts) as any[]) {
      for (const dir of [def.self, ...def.siblings])
        expect(layout.repos[dir]).toBeTruthy();
    }
  });

  it("layout.json lists the devbox's gated repos, each at the branch it lands on", () => {
    // the devbox gates these (gate.sh repos); its gate reads a repo's Depends-On: through this layout
    expect(L.repoNamed("bridge", layout)).toMatchObject({
      dir: "synap-bridge",
      fullName: "Synap-core/synap-bridge",
      defaultBranch: "master",
    });
    expect(L.repoNamed("content-studio", layout)).toMatchObject({
      dir: "site-content-studio",
      fullName: "Synap-core/site-content-studio",
    });
    for (const def of Object.values(layout.repos) as any[])
      if ("defaultBranch" in def)
        expect(def.defaultBranch).toMatch(/^[\w./-]+$/);
  });

  it("sibling-checkout.mjs derives its sibling list from layout.json", () => {
    expect(Object.keys(SIBLINGS).sort()).toEqual(
      Object.keys(layout.repos)
        .filter((d) => d !== "synap-backend")
        .sort()
    );
    expect(SIBLINGS["synap-app"]).toEqual({
      env: "SYNAP_APP_DIR",
      names: ["synap-app", "app-bases"],
    });
    const union = [
      ...read("scripts/sibling-checkout.d.mts").matchAll(/\|\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(
      union.sort(),
      "sibling-checkout.d.mts SiblingRepo must list exactly layout.json's dirs"
    ).toEqual(Object.keys(SIBLINGS).sort());
  });

  it("backend CI lays its siblings out through the resolver, with no checkout of its own", () => {
    const action = read(".github/actions/monorepo-setup/action.yml");
    expect(action).toContain(
      'scripts/layout/layout.mjs" materialize backend-ci'
    );
    expect(
      action,
      "a sibling checked out beside the resolver is a second layout"
    ).not.toMatch(/repository:\s*Synap-core\//);
    // The layout it promises the tripwires is the one layout.json declares.
    expect(layout.layouts["backend-ci"].siblings.sort()).toEqual([
      "synap-app",
      "synap-control-plane-api",
    ]);
  });

  it("the hold runs the default branch's code, never the PR's", () => {
    const wf = read(".github/workflows/depends-on.yml");
    const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    expect(on).toContain("pull_request_target:");
    expect(
      on,
      "a pull_request trigger would run the PR's own copy of the check"
    ).not.toMatch(/^\s+pull_request:/m);
    expect(wf, "the hold must never check out the PR's code").not.toMatch(
      /pull_request\.head|head_ref|refs\/pull/
    );
    expect(wf).toContain("node scripts/layout/hold.mjs");
    expect(H.CHECK_NAME).toBe("Dependencies merged");
  });
});

describe("sibling fetch retries a transient failure, only", () => {
  const ARGS = ["-C", "d", "fetch", "-q", "--depth", "1", "origin", "main"];
  const transient = () =>
    new Error(
      "git fetch failed: error: RPC failed; HTTP 404\nfatal: expected 'packfile'"
    );
  /** A fake git that throws the given errors in order, then answers "ok". */
  const fakeGit = (errors: Error[]) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      const e = errors.shift();
      if (e) throw e;
      return "ok";
    };
    return { run, calls };
  };
  const opts = (run: (a: string[]) => string) => {
    const slept: number[] = [];
    const logs: string[] = [];
    return {
      slept,
      logs,
      o: {
        run,
        sleep: (ms: number) => slept.push(ms),
        log: (m: string) => logs.push(m),
      },
    };
  };

  it("fails twice transiently, then succeeds, and logs each retry", () => {
    const g = fakeGit([transient(), new Error("Connection reset by peer")]);
    const { o, slept, logs } = opts(g.run);
    expect(L.gitNetwork(ARGS, o)).toBe("ok");
    expect(g.calls).toHaveLength(3);
    expect(slept).toEqual([2000, 5000]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("attempt 1/3");
  });

  it("a non-transient error throws at once, with no retry", () => {
    const g = fakeGit([new Error("fatal: couldn't find remote ref nope")]);
    const { o, slept } = opts(g.run);
    expect(() => L.gitNetwork(ARGS, o)).toThrow(/couldn't find remote ref/);
    expect(g.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("three transient failures throw, naming the attempts", () => {
    const g = fakeGit([transient(), transient(), transient()]);
    const { o } = opts(g.run);
    expect(() => L.gitNetwork(ARGS, o)).toThrow(/gave up after 3 attempts/);
    expect(g.calls).toHaveLength(3);
  });

  it("knows the transient signatures, and not an auth failure", () => {
    for (const m of [
      "RPC failed; HTTP 404",
      "The requested URL returned error: HTTP 503",
      "expected 'packfile'",
      "Could not resolve host: github.com",
      "Connection reset by peer",
      "Operation timed out",
    ])
      expect(L.isTransientGitError(m), m).toBe(true);
    expect(L.isTransientGitError("fatal: Authentication failed")).toBe(false);
  });

  it("materialize fetches through the retry, not a bare git()", () => {
    const src = read("scripts/layout/layout.mjs");
    expect(src).toMatch(/gitNetwork\(\[\s*\.\.\.auth,[\s\S]*?"fetch"/);
    expect(src).not.toMatch(/\n\s+git\(\[\.\.\.auth/);
  });
});

// Plan b5820982 §2 P0: backend CI read control-plane-api at its moving main,
// so a CP change turned unrelated backend PRs and main red. A sibling is now
// laid out at its pin (sibling-pins.json) unless a --ref or a pending
// Depends-On says otherwise.
describe("sibling pins: which commit a sibling is laid out at", () => {
  const CP = "synap-control-plane-api";
  const sha = (c: string) => c.repeat(40);
  const row = (over: Record<string, string> = {}) => ({
    dir: CP,
    repo: "Synap-core/control-plane-api",
    ref: sha("a"),
    ...over,
  });

  it("--ref, then a pending Depends-On, then the pin, then the default branch", () => {
    const refs = new Map([[CP, "refs/pull/9/head"]]);
    const dependsOn = new Map([[CP, sha("d")]]);
    const pins = new Map([[CP, sha("a")]]);
    const at = (o: object) => L.siblingRef(CP, { layout, ...o });
    expect(at({ refs, dependsOn, pins })).toEqual({
      ref: "refs/pull/9/head",
      from: "--ref",
    });
    expect(at({ dependsOn, pins })).toEqual({
      ref: sha("d"),
      from: "Depends-On",
    });
    expect(at({ pins })).toEqual({ ref: sha("a"), from: "pin" });
    expect(at({})).toEqual({ ref: "main", from: "default branch" });
    // a pin of another sibling moves nothing here
    expect(
      L.siblingRef("synap-app", { layout, pins }).from,
      "a pin of another sibling moves nothing here"
    ).toBe("default branch");
    expect(L.siblingRef("synap-bridge", { layout }).ref).toBe("master");
  });

  it("materialize picks every sibling's ref through siblingRef, and checks a pinned checkout landed on the pin", () => {
    const src = read("scripts/layout/layout.mjs");
    const body = src.slice(src.indexOf("export function materialize("));
    expect(body).toMatch(
      /const \{ ref, from \} = siblingRef\(dir, \{ refs, dependsOn, pins, layout \}\)/
    );
    expect(body).toMatch(/from === "pin" && sha !== ref/);
    // The CLI keeps the two sources apart, so --ref can win over Depends-On.
    expect(src).toMatch(/dependsOn\.set\(d, r\)/);
  });

  it("reads a pins manifest in relay's monorepo.json shape, with the Depends-On grammar", () => {
    const pins = L.siblingPins({ repos: [row()] }, { layout });
    expect([...pins]).toEqual([[CP, sha("a")]]);
    expect(L.pinLines({ repos: [row()] })).toBe(
      `Depends-On: Synap-core/control-plane-api@${sha("a")}`
    );
  });

  it("a malformed pin fails loudly, never reads as 'no pin'", () => {
    const bad: [unknown, RegExp][] = [
      [{}, /"repos" must be an array/],
      [{ repos: [row({ ref: "main" })] }, /full 40-character commit sha/],
      [{ repos: [row({ ref: "abc1234" })] }, /full 40-character commit sha/],
      [
        { repos: [row({ dir: "synap-app" })] },
        /checked out as synap-control-plane-api, not synap-app/,
      ],
      [{ repos: [row({ repo: "Synap-core/nope" })] }, /unknown repo/],
      [{ repos: [row(), row({ ref: sha("b") })] }, /pinned twice/],
      [{ repos: [row(), row()] }, /pinned twice/],
    ];
    for (const [manifest, why] of bad)
      expect(
        () => L.siblingPins(manifest, { layout }),
        JSON.stringify(manifest)
      ).toThrow(why);
  });

  it("the CLI refuses a malformed pins file before it clones anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "pins-"));
    try {
      const pinsFile = join(dir, "pins.json");
      writeFileSync(
        pinsFile,
        JSON.stringify({ repos: [row({ ref: "main" })] })
      );
      const r = spawnSync(
        "node",
        [
          "scripts/layout/layout.mjs",
          "materialize",
          "backend-ci",
          "--root",
          join(dir, "root"),
          "--pins",
          pinsFile,
        ],
        {
          cwd: REPO,
          encoding: "utf8",
          // No credentials at all: a resolver that ignored the pins would
          // fail its fetch here, never clone a private sibling.
          env: {
            ...process.env,
            LAYOUT_TOKEN: "",
            GITHUB_TOKEN: "",
            GH_TOKEN: "",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        }
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("full 40-character commit sha");
      expect(existsSync(join(dir, "root"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("this repo pins control-plane-api at a full sha, in a root file backend CI reads", () => {
    const pins = L.loadSiblingPins(join(REPO, L.PINS_FILE_NAME), { layout });
    expect(pins.get(CP)).toMatch(/^[0-9a-f]{40}$/);
    // CI lays the siblings out with --self-path: the pins come from there.
    const action = read(".github/actions/monorepo-setup/action.yml");
    expect(action).toMatch(
      /materialize backend-ci \\\n\s+--root "\$\{GITHUB_WORKSPACE\}\/\.\." --self-path "\$\{GITHUB_WORKSPACE\}"/
    );
    // every pinned sibling is one backend CI lays out
    for (const dir of pins.keys())
      expect(layout.layouts["backend-ci"].siblings).toContain(dir);
  });
});
