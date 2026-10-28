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
import { readFileSync } from "node:fs";
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
