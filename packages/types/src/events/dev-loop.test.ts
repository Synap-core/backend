import { describe, it, expect } from "vitest";
import {
  DEV_LOOP_EVENT_TYPES,
  OBSERVATION_NAMESPACES,
  checkDevLoopPayload,
  parsePullRequestRef,
  podSessionIdFromBody,
  pullRequestOutcomeKey,
  pullRequestUrl,
  samePullRequest,
} from "../index.js";

const SID = "cb0df539-7346-4db4-bf7d-a42b2abed58c";

describe("the dev-loop event names obey the observation door", () => {
  it.each(Object.values(DEV_LOOP_EVENT_TYPES))(
    "%s is in a registered namespace and ends in no reserved phase",
    (type) => {
      const ns = type.split(".")[0];
      expect(OBSERVATION_NAMESPACES as readonly string[]).toContain(ns);
      for (const phase of [".validated", ".completed", ".failed"]) {
        expect(type.endsWith(phase)).toBe(false);
      }
    }
  );
});

describe("parsePullRequestRef", () => {
  it.each([
    [
      "https://github.com/Synap-core/backend/pull/255",
      "Synap-core/backend",
      255,
    ],
    [
      "https://github.com/Synap-core/backend/pull/255/files",
      "Synap-core/backend",
      255,
    ],
    [
      "https://github.com/Synap-core/backend/pull/255#issuecomment-1",
      "Synap-core/backend",
      255,
    ],
    ["http://www.github.com/a/b.c/pull/7?x=1", "a/b.c", 7],
    ["Synap-core/backend#255", "Synap-core/backend", 255],
  ])("reads %s", (input, repo, number) => {
    expect(parsePullRequestRef(input)).toEqual({ repo, number });
  });

  it.each([
    "https://github.com/Synap-core/backend/issues/255",
    "https://gitlab.com/a/b/pull/1",
    "https://github.com/Synap-core/backend/pull/2550x",
    "backend#255",
    "",
  ])("refuses %s", (input) => {
    expect(parsePullRequestRef(input)).toBeNull();
  });

  it("never confuses #25 with #255 (a prefix is not the same PR)", () => {
    const a = parsePullRequestRef("https://github.com/x/y/pull/25")!;
    const b = parsePullRequestRef("https://github.com/x/y/pull/255")!;
    expect(samePullRequest(a, b)).toBe(false);
  });

  it("compares repos case-insensitively, as GitHub does", () => {
    expect(
      samePullRequest(
        { repo: "Synap-core/Backend", number: 1 },
        { repo: "synap-core/backend", number: 1 }
      )
    ).toBe(true);
  });

  it("builds the canonical url and the conventional outcome key", () => {
    const pr = { repo: "Synap-core/backend", number: 255 };
    expect(pullRequestUrl(pr)).toBe(
      "https://github.com/Synap-core/backend/pull/255"
    );
    expect(pullRequestOutcomeKey(pr)).toBe("pr-backend-255");
    expect(
      pullRequestOutcomeKey({ repo: "Synap-core/app-bases", number: 82 })
    ).toBe("pr-app-bases-82");
  });
});

describe("podSessionIdFromBody", () => {
  it("reads the Pod session line", () => {
    expect(podSessionIdFromBody(`Fixes x\n\nPod session: ${SID}\n`)).toBe(SID);
    expect(podSessionIdFromBody(`Pod session: \`${SID.toUpperCase()}\``)).toBe(
      SID
    );
  });
  it("reads every spelling the producers and the Work Map read (ONE rule)", () => {
    expect(podSessionIdFromBody(`**Pod session:** ${SID.toUpperCase()}`)).toBe(
      SID
    );
    expect(podSessionIdFromBody(`- Pod session ${SID}`)).toBe(SID);
    expect(podSessionIdFromBody(`x\n> pod session: ${SID}`)).toBe(SID);
  });
  it("never reads prose that merely mentions a session mid-line", () => {
    expect(podSessionIdFromBody(`See the Pod session ${SID} too`)).toBeNull();
  });
  it("is null when there is none", () => {
    expect(podSessionIdFromBody("no line here")).toBeNull();
    expect(podSessionIdFromBody(undefined)).toBeNull();
  });
});

describe("checkDevLoopPayload", () => {
  const pr = {
    repo: "Synap-core/backend",
    number: 255,
    url: "https://github.com/Synap-core/backend/pull/255",
  };

  it("accepts a well-formed PR fact, with extra fields", () => {
    expect(checkDevLoopPayload("dev.pr_merged", { ...pr, extra: 1 })).toEqual({
      contract: true,
      ok: true,
    });
  });

  it("refuses a url that names another PR than repo#number", () => {
    const r = checkDevLoopPayload("dev.pr_merged", {
      ...pr,
      url: "https://github.com/Synap-core/backend/pull/25",
    });
    expect(r).toMatchObject({ contract: true, ok: false });
  });

  it("carries intoDefault as a boolean, never a string", () => {
    expect(
      checkDevLoopPayload("dev.pr_merged", { ...pr, intoDefault: true })
    ).toEqual({ contract: true, ok: true });
    expect(
      checkDevLoopPayload("dev.pr_merged", { ...pr, intoDefault: "yes" })
    ).toMatchObject({ contract: true, ok: false });
  });

  it("refuses a missing number, a bad repo, a bad session id", () => {
    expect(
      checkDevLoopPayload("dev.pr_opened", { ...pr, number: undefined })
    ).toMatchObject({ ok: false });
    expect(
      checkDevLoopPayload("dev.pr_closed", { ...pr, repo: "backend" })
    ).toMatchObject({ ok: false });
    expect(
      checkDevLoopPayload("dev.pr_merged", { ...pr, sessionId: "nope" })
    ).toMatchObject({ ok: false });
  });

  it("ci.finished needs a known status, a sha and a repo", () => {
    const ok = {
      status: "success",
      sha: "91de41c34",
      repo: "Synap-core/backend",
      pr: 255,
    };
    expect(checkDevLoopPayload("ci.finished", ok)).toEqual({
      contract: true,
      ok: true,
    });
    expect(
      checkDevLoopPayload("ci.finished", { ...ok, status: "green" })
    ).toMatchObject({ ok: false });
    expect(
      checkDevLoopPayload("ci.finished", { ...ok, sha: "main" })
    ).toMatchObject({ ok: false });
  });

  it("dev.deployed needs a target and a sha", () => {
    expect(
      checkDevLoopPayload("dev.deployed", { target: "pod.x", sha: "abc1234" })
    ).toEqual({
      contract: true,
      ok: true,
    });
    expect(
      checkDevLoopPayload("dev.deployed", { target: "pod.x", sha: "" })
    ).toMatchObject({ ok: false });
  });

  it("leaves every other type free-form", () => {
    expect(checkDevLoopPayload("dev.commit", { whatever: true })).toEqual({
      contract: false,
    });
  });
});
