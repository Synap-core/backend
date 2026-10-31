/**
 * The ONE dedupe key of an observed fact: the same fact from any producer is
 * one key, and two facts are two keys. Each row below rules something out:
 * a key built from the producer, the hearing time or the spelling would merge
 * or split the wrong pairs.
 */
import { describe, it, expect } from "vitest";
import { observationFactKey } from "./fact-key.js";

const PR = {
  repo: "Synap-core/backend",
  number: 12,
  url: "https://github.com/Synap-core/backend/pull/12",
};
const AT = new Date("2026-10-28T20:04:31Z");

describe("observationFactKey", () => {
  it("a merge is one fact per PR, whoever reports it and whenever", () => {
    const webhook = observationFactKey(
      "dev.pr_merged",
      { ...PR, source: "github-webhook", sha: "a".repeat(40) },
      AT
    );
    const gapFiller = observationFactKey(
      "dev.pr_merged",
      { ...PR, repo: "synap-core/BACKEND", source: "devbox-pr-gap-filler" },
      undefined
    );
    expect(webhook).toBe("dev.pr_merged:synap-core/backend#12");
    expect(gapFiller).toBe(webhook);
  });

  it("a merge of another PR, or in another repo, is another fact", () => {
    const a = observationFactKey("dev.pr_merged", PR);
    expect(observationFactKey("dev.pr_merged", { ...PR, number: 13 })).not.toBe(
      a
    );
    expect(
      observationFactKey("dev.pr_merged", { ...PR, repo: "Synap-core/browser" })
    ).not.toBe(a);
    // The automation's templated payload sends the number as text.
    expect(observationFactKey("dev.pr_merged", { ...PR, number: "12" })).toBe(
      a
    );
  });

  it("each open and each close is its own fact (a reopen-close cycle is two closes)", () => {
    const close1 = observationFactKey("dev.pr_closed", PR, AT);
    const close1Again = observationFactKey(
      "dev.pr_closed",
      PR,
      new Date(AT.getTime())
    );
    const close2 = observationFactKey(
      "dev.pr_closed",
      PR,
      new Date("2026-10-29T08:00:00Z")
    );
    expect(close1).toBe(close1Again);
    expect(close2).not.toBe(close1);
    expect(observationFactKey("dev.pr_opened", PR, AT)).not.toBe(close1);
  });

  it("a CI run is one fact per repo, sha, run and status", () => {
    const sha = "B".repeat(40);
    const base = {
      repo: "Synap-core/backend",
      sha,
      status: "success",
      url: "https://github.com/Synap-core/backend/actions/runs/1",
      workflow: "CI",
    };
    const k = observationFactKey("ci.finished", base);
    expect(k).toBe(
      `ci.finished:synap-core/backend@${"b".repeat(40)}:https://github.com/Synap-core/backend/actions/runs/1:success`
    );
    expect(observationFactKey("ci.finished", { ...base })).toBe(k);
    // A re-run that turned red is a new verdict.
    expect(
      observationFactKey("ci.finished", { ...base, status: "failure" })
    ).not.toBe(k);
    // Another run at the same sha is another fact.
    expect(
      observationFactKey("ci.finished", {
        ...base,
        url: "https://github.com/Synap-core/backend/actions/runs/2",
      })
    ).not.toBe(k);
    // With no url, the workflow names the run (the org hook's check suites).
    const { url: _url, ...noUrl } = base;
    expect(observationFactKey("ci.finished", noUrl)).toBe(
      `ci.finished:synap-core/backend@${"b".repeat(40)}:CI:success`
    );
  });

  it("a run's start is one fact per run and attempt; it never merges with its finish", () => {
    const base = {
      repo: "Synap-core/backend",
      sha: "B".repeat(40),
      url: "https://github.com/Synap-core/backend/actions/runs/1",
      workflow: "CI",
    };
    const start = observationFactKey("ci.started", base, AT);
    expect(start).toBe(
      `ci.started:synap-core/backend@${"b".repeat(40)}:https://github.com/Synap-core/backend/actions/runs/1@${AT.toISOString()}`
    );
    expect(observationFactKey("ci.started", { ...base }, new Date(AT))).toBe(
      start
    );
    // A re-run attempt of the same run starts again: another fact.
    expect(
      observationFactKey("ci.started", base, new Date("2026-10-28T21:00:00Z"))
    ).not.toBe(start);
    expect(
      observationFactKey("ci.finished", { ...base, status: "success" }, AT)
    ).not.toBe(start);
    expect(
      observationFactKey("ci.started", { repo: "Synap-core/backend" })
    ).toBeNull();
  });

  it("each entry into the merge queue is its own fact", () => {
    const q1 = observationFactKey("dev.merge_queued", PR, AT);
    expect(q1).toBe(
      `dev.merge_queued:synap-core/backend#12@${AT.toISOString()}`
    );
    expect(
      observationFactKey(
        "dev.merge_queued",
        PR,
        new Date("2026-10-29T08:00:00Z")
      )
    ).not.toBe(q1);
    expect(observationFactKey("dev.pr_opened", PR, AT)).not.toBe(q1);
  });

  it("facts the pod reads newest-wins, or that may repeat, carry no key", () => {
    expect(
      observationFactKey("dev.repo_snapshot", { repo: "Synap-core/backend" })
    ).toBeNull();
    expect(
      observationFactKey("dev.deployed", {
        repo: "Synap-core/backend",
        sha: "c".repeat(40),
        target: "pod",
      })
    ).toBeNull();
    expect(
      observationFactKey("dev.commit", { repo: "Synap-core/backend" })
    ).toBeNull();
  });

  it("a payload missing its identity carries no key (never a key that merges unrelated facts)", () => {
    expect(observationFactKey("dev.pr_merged", { number: 12 })).toBeNull();
    expect(
      observationFactKey("dev.pr_merged", { repo: "Synap-core/backend" })
    ).toBeNull();
    expect(
      observationFactKey("ci.finished", {
        repo: "Synap-core/backend",
        status: "success",
      })
    ).toBeNull();
  });
});
