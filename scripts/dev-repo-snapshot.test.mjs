/**
 * Fixture tests for dev-repo-snapshot.mjs: the parsers and the stage inputs, with no network.
 * Run anywhere with node (no install): `node --test scripts/dev-repo-snapshot.test.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorLogin,
  buildPr,
  checksFromDevbox,
  checksFromRollup,
  dependsOnFromBody,
  fingerprint,
  fixedByFromPrs,
  parseFixedByOverrides,
  inheritedFromMain,
  mainFailingNames,
  mainHealthFromBaselines,
  mainHealthFromGithub,
  mainHealthFromCiResult,
  mergeableFrom,
  mergedTodayFrom,
  podSessionFromBody,
  snapshotObservation,
  startOfDayMs,
} from "./dev-repo-snapshot.mjs";

const SID = "0f1e2d3c-4b5a-4968-8777-665544332211";
const R = "Synap-core/backend";

test("podSessionFromBody reads the Pod session line", () => {
  assert.equal(
    podSessionFromBody(`text\n\nPod session: ${SID.toUpperCase()}\n`),
    SID
  );
  assert.equal(podSessionFromBody("no line"), null);
  assert.equal(podSessionFromBody(`see the Pod session: ${SID} inline`), null);
});

test("dependsOnFromBody: the three phrasings, cross-repo, lists, urls, code, self", () => {
  assert.deepEqual(dependsOnFromBody("Depends on #363", R, 9), [
    { repo: R, number: 363 },
  ]);
  assert.deepEqual(
    dependsOnFromBody(
      "after Synap-core/browser#51, #52 and Synap-core/relay-app#7",
      R,
      9
    ),
    [
      { repo: "Synap-core/browser", number: 51 },
      { repo: R, number: 52 },
      { repo: "Synap-core/relay-app", number: 7 },
    ]
  );
  assert.deepEqual(
    dependsOnFromBody(
      "Stacked on https://github.com/Synap-core/app-bases/pull/108",
      R,
      9
    ),
    [{ repo: "Synap-core/app-bases", number: 108 }]
  );
  assert.deepEqual(dependsOnFromBody("depends on #9", R, 9), []);
  assert.deepEqual(
    dependsOnFromBody("```\ndepends on #1\n```\nand `after #2`", R, 9),
    []
  );
  assert.deepEqual(dependsOnFromBody("fixes #12, mentions #13", R, 9), []);
  assert.deepEqual(dependsOnFromBody(null, R, 9), []);
});

test("mergeableFrom", () => {
  assert.equal(mergeableFrom("CLEAN"), "clean");
  for (const s of ["BLOCKED", "BEHIND", "UNSTABLE", "DRAFT"])
    assert.equal(mergeableFrom(s), "blocked");
  assert.equal(mergeableFrom("DIRTY"), "dirty");
  assert.equal(mergeableFrom("UNKNOWN"), "unknown");
  assert.equal(mergeableFrom(undefined), "unknown");
});

test("authorLogin marks bots", () => {
  assert.equal(
    authorLogin({ login: "app/dependabot", is_bot: true }),
    "dependabot[bot]"
  );
  assert.equal(
    authorLogin({ login: "Antoinesrvt", is_bot: false }),
    "Antoinesrvt"
  );
  assert.equal(authorLogin(null), "unknown");
});

const run = (name, status, conclusion, extra = {}) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  workflowName: "CI",
  ...extra,
});

test("checksFromRollup", () => {
  assert.deepEqual(checksFromRollup([]), { checks: "none", failing: [] });
  assert.equal(
    checksFromRollup([
      run("a", "COMPLETED", "SUCCESS"),
      run("b", "COMPLETED", "SKIPPED"),
    ]).checks,
    "green"
  );
  const red = checksFromRollup([
    run("a", "COMPLETED", "SUCCESS"),
    run("b", "COMPLETED", "FAILURE"),
    run("c", "IN_PROGRESS", null),
  ]);
  assert.deepEqual(red, { checks: "red", failing: ["b"] });
  assert.equal(
    checksFromRollup([
      run("a", "COMPLETED", "SUCCESS"),
      run("c", "IN_PROGRESS", null),
    ]).checks,
    "running"
  );
  assert.equal(checksFromRollup([run("a", "QUEUED", null)]).checks, "queued");
  assert.equal(
    checksFromRollup([
      { __typename: "StatusContext", context: "devbox-ci", state: "FAILURE" },
    ]).checks,
    "red"
  );
  // a superseded cancelled run does not turn the rerun red
  const rerun = [
    run("Full suite", "COMPLETED", "CANCELLED", {
      startedAt: "2026-10-27T19:00:00Z",
    }),
    run("Full suite", "COMPLETED", "SUCCESS", {
      startedAt: "2026-10-27T19:30:00Z",
    }),
  ];
  assert.equal(checksFromRollup(rerun).checks, "green");
});

test("inheritedFromMain needs every failing check red on main", () => {
  assert.equal(inheritedFromMain(["typecheck"], ["typecheck", "docs"]), true);
  assert.equal(inheritedFromMain(["typecheck", "e2e"], ["typecheck"]), false);
  assert.equal(inheritedFromMain([], ["typecheck"]), false);
  assert.equal(inheritedFromMain(["typecheck"], []), false);
});

const node = (oid, state, failing = [], extra = {}) => ({
  oid,
  state,
  failing,
  committedDate: `2026-10-27T${oid.length}:00:00Z`,
  ...extra,
});

test("mainHealthFromGithub: ok, red with redSince, pending head, no checks", () => {
  assert.equal(
    mainHealthFromGithub([node("c3", "SUCCESS"), node("c2", "FAILURE", ["x"])])
      .main.health,
    "ok"
  );
  const red = mainHealthFromGithub([
    node("c5", "PENDING"),
    node("c4", "FAILURE", ["typecheck"]),
    node("c3", "FAILURE", ["typecheck"], { prNumber: 348 }),
    node("c2", "SUCCESS"),
    node("c1", "FAILURE"),
  ]);
  assert.equal(red.main.health, "red");
  assert.equal(red.main.sha, "c5");
  assert.equal(red.main.redSince.sha, "c3");
  assert.equal(red.main.redSince.prNumber, 348);
  assert.deepEqual(red.mainFailing, ["typecheck"]);
  assert.match(red.main.reason, /typecheck/);
  const none = mainHealthFromGithub([node("c1", null), node("c0", null)]);
  assert.deepEqual(
    [none.main.health, none.main.source],
    ["unmeasured", "none"]
  );
  assert.equal(
    mainHealthFromGithub([node("c1", "PENDING")]).main.health,
    "unmeasured"
  );
});

const gate = (id, status, vs_main = null) => ({ id, status, vs_main });
const base = (name, done, sha, subject, gates) => ({
  name,
  status: gates.some((g) => g.status === "red") ? "red" : "green",
  done,
  repos: { browser: { sha, subject } },
  gates,
});

test("mainHealthFromBaselines: newest gate result, infra is not red, redSince walks back", () => {
  const recent = [
    base(
      "baseline-3",
      "2026-10-27T20:00:00Z",
      "ccc",
      "Merge pull request #53 from x",
      [gate("browser-tsc", "red"), gate("browser-full", "red")]
    ),
    base(
      "baseline-l-2",
      "2026-10-27T19:00:00Z",
      "bbb",
      "Merge pull request #52 from x",
      [gate("browser-tsc", "red")]
    ),
    base(
      "baseline-1",
      "2026-10-27T18:00:00Z",
      "aaa",
      "Merge pull request #51 from x",
      [gate("browser-tsc", "green")]
    ),
    {
      name: "lane-run",
      status: "red",
      done: "2026-10-27T20:30:00Z",
      repos: { browser: { sha: "zzz" } },
      gates: [gate("browser-tsc", "red")],
    },
  ];
  const r = mainHealthFromBaselines(recent, "browser");
  assert.equal(r.main.health, "red");
  assert.equal(r.main.source, "devbox-baseline");
  assert.equal(r.main.sha, "ccc");
  assert.deepEqual(r.main.redSince, {
    sha: "bbb",
    prNumber: 52,
    at: "2026-10-27T19:00:00Z",
  });
  const infra = mainHealthFromBaselines(
    [base("baseline-1", "t", "a", "", [gate("browser-tsc", "infra")])],
    "browser"
  );
  assert.equal(infra.main.health, "infra");
  assert.equal(mainHealthFromBaselines(recent, "relay-app"), null);
  assert.equal(mainHealthFromBaselines([], "browser"), null);
});

test("mainHealthFromCiResult", () => {
  assert.equal(
    mainHealthFromCiResult("GREEN blocking 7/7", "abc").health,
    "ok"
  );
  const red = mainHealthFromCiResult("RED blocking 2/3 · red: cp-test", "abc");
  assert.equal(red.health, "red");
  assert.match(red.reason, /cp-test/);
  assert.equal(mainHealthFromCiResult("garbage", "abc"), null);
});

const head = "a38bbc4c7717535bd6ee194770976971f605dac2";
const lane = (over) => ({
  name: "lane",
  repo: "browser",
  ref: "feat/x",
  status: "red",
  done: "2026-10-27T20:00:00Z",
  repos: { browser: { sha: "a38bbc4c7" } },
  gates: [],
  ...over,
});

test("checksFromDevbox: inherited vs own red, infra, queued, other head", () => {
  const own = checksFromDevbox(
    {
      recent: [
        lane({
          gates: [
            gate("browser-tsc", "red", "same-as-main b"),
            gate("browser-file", "red", "NEW 2 not on main: x"),
          ],
        }),
      ],
    },
    "browser",
    head
  );
  assert.equal(own.checks, "red");
  assert.equal(own.redInheritedFromMain, false);
  const inh = checksFromDevbox(
    {
      recent: [
        lane({
          gates: [
            gate("browser-tsc", "red", "same-as-main b"),
            gate("browser-file", "green"),
          ],
        }),
      ],
    },
    "browser",
    head
  );
  assert.equal(inh.redInheritedFromMain, true);
  assert.equal(
    checksFromDevbox(
      {
        recent: [
          lane({ status: "green", gates: [gate("browser-file", "green")] }),
        ],
      },
      "browser",
      head
    ).checks,
    "green"
  );
  const infra = checksFromDevbox(
    { recent: [lane({ gates: [gate("browser-tsc", "infra")] })] },
    "browser",
    head
  );
  assert.equal(infra.checks, "infra");
  assert.equal(
    checksFromDevbox(
      { recent: [lane({ gates: [gate("browser-file", "green")] })] },
      "browser",
      "ffffffffffff"
    ).checks,
    "none"
  );
  assert.equal(
    checksFromDevbox(
      {
        recent: [],
        queued: { heavy: [{ repo: "browser", ref: head }], light: [] },
      },
      "browser",
      head
    ).checks,
    "queued"
  );
  // a baseline never answers for a PR head
  assert.equal(
    checksFromDevbox(
      {
        recent: [
          lane({
            name: "baseline-1",
            status: "green",
            gates: [gate("browser-tsc", "green")],
          }),
        ],
      },
      "browser",
      head
    ).checks,
    "none"
  );
});

test("buildPr: GitHub checks first, devbox when none, inherited, session, dependsOn, autoMerge", () => {
  const raw = {
    number: 400,
    title: "t",
    url: "u",
    headRefOid: head,
    isDraft: false,
    author: { login: "a", is_bot: false },
    updatedAt: "x",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: { mergeMethod: "MERGE" },
    body: `Pod session: ${SID}\n\nDepends on #363`,
    statusCheckRollup: [run("Release gate", "COMPLETED", "FAILURE")],
  };
  const pr = buildPr(raw, R, {
    mainFailing: ["Release gate"],
    devbox: () => assert.fail("not asked"),
  });
  assert.deepEqual(
    [
      pr.checks,
      pr.redInheritedFromMain,
      pr.mergeable,
      pr.autoMerge,
      pr.podSessionId,
    ],
    ["red", true, "clean", true, SID]
  );
  assert.deepEqual(pr.dependsOn, [{ repo: R, number: 363 }]);
  const fromDevbox = buildPr({ ...raw, statusCheckRollup: [] }, R, {
    mainFailing: [],
    devbox: () => ({ checks: "green" }),
  });
  assert.equal(fromDevbox.checks, "green");
  assert.equal("redInheritedFromMain" in fromDevbox, false);
});

test("mergedTodayFrom and startOfDayMs", () => {
  const now = Date.parse("2026-10-27T21:40:00Z"); // 22:40 in Paris (CET, +1)
  const start = startOfDayMs(now, "Europe/Paris");
  assert.equal(new Date(start).toISOString(), "2026-10-26T23:00:00.000Z");
  const out = mergedTodayFrom(
    [
      { number: 1, mergedAt: "2026-10-26T22:59:00Z" },
      {
        number: 2,
        mergedAt: "2026-10-27T08:00:00Z",
        body: `Pod session: ${SID}`,
      },
      { number: 3, mergedAt: "2026-10-27T20:00:00Z" },
    ],
    start
  );
  assert.deepEqual(
    out.map((p) => p.number),
    [3, 2]
  );
  assert.equal(out[1].podSessionId, SID);
});

test("fingerprint ignores observedAt; observation shape", () => {
  const s = { repo: R, observedAt: "a", prs: [] };
  assert.equal(fingerprint(s), fingerprint({ ...s, observedAt: "b" }));
  assert.notEqual(fingerprint(s), fingerprint({ ...s, prs: [1] }));
  const o = snapshotObservation(s);
  assert.deepEqual(
    [o.type, o.subjectId, o.data.repo],
    ["dev.repo_snapshot", R, R]
  );
});

test("mainFailingNames: a pending head does not hide a slow check that fails on main", () => {
  const ck = (name, kind) => ({ name, kind });
  const nodes = [
    {
      oid: "c3",
      state: "FAILURE",
      failing: ["docs"],
      checks: [ck("docs", "fail"), ck("Release gate", "run")],
    },
    {
      oid: "c2",
      state: "FAILURE",
      failing: ["Release gate"],
      checks: [ck("docs", "pass"), ck("Release gate", "fail")],
    },
  ];
  assert.deepEqual(mainFailingNames(nodes).sort(), ["Release gate", "docs"]);
  assert.deepEqual(mainHealthFromGithub(nodes).mainFailing.sort(), [
    "Release gate",
    "docs",
  ]);
  // main fixed the check since: the newest finished result wins
  const fixed = [
    {
      oid: "c3",
      state: "SUCCESS",
      failing: [],
      checks: [ck("Release gate", "pass")],
    },
    nodes[1],
  ];
  assert.deepEqual(mainFailingNames(fixed), []);
});

test("fixedBy: only a PR that says it fixes main, or the founder's mark; branch rides on the PR", () => {
  const open = [
    { number: 7, title: "feat: x", body: "unrelated" },
    { number: 9, title: "fix: typecheck", body: "Fixes main (the #348 break)" },
    { number: 8, title: "Fix main typecheck", body: "", isDraft: true },
    { number: 11, title: "fixes main", body: "" },
  ];
  assert.deepEqual(fixedByFromPrs(open, R), { repo: R, number: 9 });
  assert.equal(
    fixedByFromPrs(
      [{ number: 1, title: "fix mainstream", body: "`fixes main`" }],
      R
    ),
    null
  );
  assert.deepEqual(
    parseFixedByOverrides(
      "Synap-core/browser=Synap-core/backend#278; bad Synap-core/app-bases=Synap-core/backend#337"
    ),
    {
      "Synap-core/browser": { repo: R, number: 278 },
      "Synap-core/app-bases": { repo: R, number: 337 },
    }
  );
  const pr = buildPr(
    {
      number: 1,
      headRefOid: head,
      headRefName: "negctl/x",
      statusCheckRollup: [],
      mergeStateStatus: "CLEAN",
    },
    R,
    { mainFailing: [], devbox: () => ({ checks: "infra" }) }
  );
  assert.deepEqual([pr.branch, pr.checks], ["negctl/x", "infra"]);
});
