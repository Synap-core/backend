/**
 * Fixture tests for dev-pr-gap-filler.mjs, with no network: the fact a closed
 * PR is (merged vs closed, from the list endpoint's shape), the window it is
 * posted in, the repos, and the App JWT.
 * Run anywhere with node (no install): `node --test scripts/dev-pr-gap-filler.test.mjs`.
 */
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  appJwt,
  closedPullObservation,
  DEFAULT_REPOS,
  parseRepos,
  selectGaps,
  SOURCE,
  stateKey,
} from "./dev-pr-gap-filler.mjs";

const R = "Synap-core/backend";
const SID = "0f1e2d3c-4b5a-4968-8777-665544332211";

/** A PR as `GET /repos/{repo}/pulls?state=closed` returns it: no `merged` flag. */
function listedPr(over = {}) {
  return {
    number: 12,
    title: "Fix the door",
    body: `Pod session: ${SID}`,
    closed_at: "2026-10-29T10:00:00Z",
    merged_at: "2026-10-29T10:00:00Z",
    merge_commit_sha: "a".repeat(40),
    head: {
      sha: "b".repeat(40),
      ref: "fix/door",
      repo: { full_name: "Synap-core/backend" },
    },
    base: { ref: "main" },
    user: { login: "someone" },
    ...over,
  };
}

test("a merged PR from the list endpoint is dev.pr_merged, the workflow's shape, our source", () => {
  const obs = closedPullObservation(listedPr(), R, "main");
  assert.equal(obs.type, "dev.pr_merged");
  assert.equal(obs.subjectId, `${R}#12`);
  assert.equal(obs.occurredAt, "2026-10-29T10:00:00Z");
  assert.equal(obs.data.sha, "a".repeat(40)); // the merge commit
  assert.equal(obs.data.intoDefault, true);
  assert.equal(obs.data.sessionId, SID);
  assert.equal(obs.data.url, `https://github.com/${R}/pull/12`);
  assert.equal(obs.data.source, SOURCE);
});

test("a fork's merged PR names no session (the same in-repo-branch rule as the workflow)", () => {
  const obs = closedPullObservation(
    listedPr({
      head: {
        sha: "b".repeat(40),
        ref: "fix/door",
        repo: { full_name: "someone/backend" },
      },
    }),
    R,
    "main"
  );
  assert.equal(obs.type, "dev.pr_merged");
  assert.equal(obs.data.sessionId, undefined);
  assert.equal(obs.data.body, undefined);
});

test("a closed, unmerged PR is dev.pr_closed at its closed_at", () => {
  const obs = closedPullObservation(
    listedPr({ merged_at: null, closed_at: "2026-10-29T09:00:00Z" }),
    R,
    "main"
  );
  assert.equal(obs.type, "dev.pr_closed");
  assert.equal(obs.occurredAt, "2026-10-29T09:00:00Z");
  assert.equal(obs.data.sha, "b".repeat(40)); // the head
});

test("a stacked PR (base is not the default branch) says so", () => {
  const obs = closedPullObservation(
    listedPr({ base: { ref: "feat/x" } }),
    R,
    "main"
  );
  assert.equal(obs.data.intoDefault, false);
});

const NOW = new Date("2026-10-29T12:00:00Z");
const WINDOW = {
  since: new Date("2026-10-29T00:00:00Z"),
  now: NOW,
  graceMs: 10 * 60_000,
  lookbackMs: 72 * 3600_000,
};
const at = (iso, n = 1) =>
  closedPullObservation(
    listedPr({ number: n, merged_at: iso, closed_at: iso }),
    R,
    "main"
  );

test("posts only facts closed after GAPFILL_SINCE and before the grace", () => {
  const before = at("2026-10-28T23:59:00Z", 1); // before the pod keyed facts
  const inside = at("2026-10-29T11:00:00Z", 2);
  const tooFresh = at("2026-10-29T11:55:00Z", 3); // the webhook still has its chance
  const picked = selectGaps([before, inside, tooFresh], {
    ...WINDOW,
    posted: new Set(),
  });
  assert.deepEqual(
    picked.map((o) => o.data.number),
    [2]
  );
});

test("the lookback caps the window even when GAPFILL_SINCE is older", () => {
  const old = at("2026-10-20T10:00:00Z", 4);
  const picked = selectGaps([old], {
    ...WINDOW,
    since: new Date("2026-10-01T00:00:00Z"),
    posted: new Set(),
  });
  assert.equal(picked.length, 0);
});

test("a fact already posted is not posted again; another close of the same PR is", () => {
  const first = at("2026-10-29T08:00:00Z", 5);
  const posted = new Set([stateKey(first)]);
  assert.equal(selectGaps([first], { ...WINDOW, posted }).length, 0);
  const reclosed = closedPullObservation(
    listedPr({ number: 5, merged_at: null, closed_at: "2026-10-29T09:00:00Z" }),
    R,
    "main"
  );
  assert.equal(selectGaps([reclosed], { ...WINDOW, posted }).length, 1);
});

test("repos: --repo wins, then GAPFILL_REPOS, then the default list; bare names are the org's", () => {
  assert.deepEqual(parseRepos(["--repo", "browser"], {}), [
    "Synap-core/browser",
  ]);
  assert.deepEqual(parseRepos([], { GAPFILL_REPOS: "backend, Other/x" }), [
    "Synap-core/backend",
    "Other/x",
  ]);
  assert.deepEqual(parseRepos([], {}), DEFAULT_REPOS);
  assert.ok(DEFAULT_REPOS.length >= 6);
});

test("the App JWT is RS256, issued by the app id, valid under 10 minutes, and verifies", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = appJwt("5487355", pem, 1_000_000);
  const [h, p, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "5487355");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(
    createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(sig, "base64url"))
  );
});
