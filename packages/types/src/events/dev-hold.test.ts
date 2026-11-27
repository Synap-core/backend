/**
 * Is the dev fact a hold waits on in? (`holdDevRefMet`) — and which hold ref a
 * just-recorded fact may resume (`holdDevFactOf`). Pure, over the rows the
 * hold-resume worker reads.
 */
import { describe, expect, it } from "vitest";

import { DEV_LOOP_EVENT_TYPES as T } from "./dev-loop.js";
import {
  aiHoldMet,
  holdDevFactOf,
  holdDevRefMet,
  holdDevRefNamed,
} from "./dev-hold.js";
import type { DevLoopEventRowLike } from "./pr-state.js";

const SINCE = "2026-10-30T12:00:00.000Z";
const at = (min: number) =>
  new Date(Date.parse(SINCE) + min * 60_000).toISOString();
const BE = "Synap-core/backend";
const PR = { kind: "pr" as const, repo: "synap-core/backend", number: 47 };
const prRow = (type: string, min: number, over = {}): DevLoopEventRowLike => ({
  type,
  timestamp: at(min),
  data: {
    repo: BE,
    number: 47,
    url: `https://github.com/${BE}/pull/47`,
    ...over,
  },
});
const snap = (min: number, observedMin: number, health: string) => ({
  type: T.repoSnapshot,
  timestamp: at(min),
  data: { repo: BE, observedAt: at(observedMin), main: { health } },
});
const job = (min: number, status: string, name = "dev-feed-h") => ({
  type: T.ciFinished,
  timestamp: at(min),
  data: { repo: BE, sha: "a".repeat(40), status, workflow: `devbox ${name}` },
});
/** A CI run of PR 47, as the producer posts it (`pod-observation.mjs`). */
const ci = (
  min: number,
  status: string,
  verdict: string | null,
  over: Record<string, unknown> = {}
): DevLoopEventRowLike => ({
  type: T.ciFinished,
  timestamp: at(min),
  data: {
    repo: BE,
    sha: "b".repeat(40),
    status,
    pr: 47,
    workflow: "CI",
    ...(verdict ? { requiredChecks: { verdict } } : {}),
    ...over,
  },
});

describe("holdDevRefMet", () => {
  it("pr: met once it merged into main (any time); closed only with to: closed", () => {
    const opened = prRow(T.prOpened, -60);
    expect(holdDevRefMet(PR, {}, SINCE, [opened])).toBe(false);
    const merged = prRow(T.prMerged, -5, { intoDefault: true });
    // Merged before the pause began: what it waits on is already over.
    expect(holdDevRefMet(PR, {}, SINCE, [opened, merged])).toBe(true);
    expect(holdDevRefMet(PR, { to: "closed" }, SINCE, [opened, merged])).toBe(
      false
    );
    const closed = prRow(T.prClosed, 5);
    expect(holdDevRefMet(PR, {}, SINCE, [opened, closed])).toBe(false);
    expect(holdDevRefMet(PR, { to: "closed" }, SINCE, [opened, closed])).toBe(
      true
    );
  });

  it("pr: a merge into another branch (a stacked PR) is not the merge waited on", () => {
    const stacked = prRow(T.prMerged, 5, { intoDefault: false });
    expect(holdDevRefMet(PR, {}, SINCE, [stacked])).toBe(false);
  });

  it("pr checks_failed / checks_green: the newest CI run after the pause, by its required-checks verdict", () => {
    const red = ci(5, "failure", "red");
    const green = ci(9, "success", "green");
    const FAILED = { to: "checks_failed" };
    const GREEN = { to: "checks_green" };
    expect(holdDevRefMet(PR, FAILED, SINCE, [red])).toBe(true);
    expect(holdDevRefMet(PR, GREEN, SINCE, [red])).toBe(false);
    expect(holdDevRefMet(PR, GREEN, SINCE, [green])).toBe(true);
    expect(holdDevRefMet(PR, FAILED, SINCE, [green])).toBe(false);
    // A rerun ends later: its verdict wins, in either order of the rows.
    expect(holdDevRefMet(PR, FAILED, SINCE, [green, red])).toBe(false);
    expect(holdDevRefMet(PR, GREEN, SINCE, [green, red])).toBe(true);
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [ci(12, "failure", "red"), green])
    ).toBe(true);
    // A run that ended before the pause says nothing about the push it waits on.
    expect(holdDevRefMet(PR, FAILED, SINCE, [ci(-5, "failure", "red")])).toBe(
      false
    );
    // Pending, no CI, or no verdict computed: not yet.
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [ci(5, "failure", "pending")])
    ).toBe(false);
    expect(holdDevRefMet(PR, FAILED, SINCE, [ci(5, "failure", "no_ci")])).toBe(
      false
    );
    expect(holdDevRefMet(PR, FAILED, SINCE, [ci(5, "failure", null)])).toBe(
      false
    );
    // A newest run with no verdict hides the older red: it may have passed.
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [red, ci(7, "success", null)])
    ).toBe(false);
  });

  it("pr checks: a draft, another PR, a devbox job, another workflow or a cancelled run never counts", () => {
    const FAILED = { to: "checks_failed" };
    // A draft's CI is red by design ("Suites not run (draft)").
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [
        ci(5, "failure", "red", { draft: true }),
      ])
    ).toBe(false);
    // The older ready run's red stays the newest that counts.
    expect(
      holdDevRefMet(PR, { to: "checks_green" }, SINCE, [
        ci(3, "failure", "red"),
        ci(5, "success", "green", { draft: true }),
      ])
    ).toBe(false);
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [ci(5, "failure", "red", { pr: 48 })])
    ).toBe(false);
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [
        ci(5, "failure", "red", { repo: "Synap-core/app-bases" }),
      ])
    ).toBe(false);
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [
        ci(5, "failure", "red", { workflow: "devbox be-file" }),
      ])
    ).toBe(false);
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [
        ci(5, "failure", "red", { workflow: "Depends-On" }),
      ])
    ).toBe(false);
    expect(holdDevRefMet(PR, FAILED, SINCE, [ci(5, "cancelled", "red")])).toBe(
      false
    );
    // The repo's case does not matter (GitHub compares it without).
    expect(
      holdDevRefMet(PR, FAILED, SINCE, [
        ci(5, "failure", "red", { repo: "SYNAP-CORE/Backend" }),
      ])
    ).toBe(true);
  });

  it("pr merged / closed never read the checks", () => {
    const opened = prRow(T.prOpened, -60);
    const red = ci(5, "failure", "red");
    const green = ci(6, "success", "green");
    expect(holdDevRefMet(PR, {}, SINCE, [opened, red, green])).toBe(false);
    expect(holdDevRefMet(PR, { to: "closed" }, SINCE, [opened, red])).toBe(
      false
    );
  });

  it("main: the newest snapshot OBSERVED after the pause says ok", () => {
    const ref = { kind: "main" as const, repo: "synap-core/backend" };
    // Green before the pause says nothing; red after it holds.
    expect(holdDevRefMet(ref, {}, SINCE, [snap(-1, -1, "ok")])).toBe(false);
    expect(holdDevRefMet(ref, {}, SINCE, [snap(2, 2, "red")])).toBe(false);
    expect(
      holdDevRefMet(ref, {}, SINCE, [snap(2, 2, "red"), snap(4, 4, "ok")])
    ).toBe(true);
    // The newest wins: red again after the green.
    expect(
      holdDevRefMet(ref, {}, SINCE, [snap(4, 4, "ok"), snap(6, 6, "red")])
    ).toBe(false);
  });

  it("job: its run that ended after the pause; `to` picks the verdict", () => {
    const ref = { kind: "job" as const, name: "dev-feed-h" };
    expect(holdDevRefMet(ref, {}, SINCE, [job(-10, "success")])).toBe(false);
    expect(holdDevRefMet(ref, {}, SINCE, [job(3, "failure", "other")])).toBe(
      false
    );
    expect(holdDevRefMet(ref, {}, SINCE, [job(3, "failure")])).toBe(true);
    // A cancelled or skipped run has no verdict: it resumes nothing.
    expect(holdDevRefMet(ref, {}, SINCE, [job(3, "cancelled")])).toBe(false);
    expect(holdDevRefMet(ref, {}, SINCE, [job(3, "skipped")])).toBe(false);
    expect(
      holdDevRefMet(ref, { to: "passed" }, SINCE, [job(3, "failure")])
    ).toBe(false);
    expect(
      holdDevRefMet(ref, { to: "failed" }, SINCE, [job(3, "failure")])
    ).toBe(true);
  });
});

describe("holdDevFactOf", () => {
  it("names the hold ref a fact may resume, in its stored spelling", () => {
    expect(holdDevFactOf(T.prMerged, prRow(T.prMerged, 0).data)).toBe(
      "pr:synap-core/backend#47"
    );
    expect(holdDevFactOf(T.prClosed, prRow(T.prClosed, 0).data)).toBe(
      "pr:synap-core/backend#47"
    );
    expect(holdDevFactOf(T.repoSnapshot, snap(0, 0, "ok").data)).toBe(
      "main:synap-core/backend"
    );
    expect(holdDevFactOf(T.ciFinished, job(0, "success").data)).toBe(
      "job:dev-feed-h"
    );
    // A PR's CI run: a hold on that PR's checks verdict may be met.
    expect(holdDevFactOf(T.ciFinished, ci(0, "failure", "red").data)).toBe(
      "pr:synap-core/backend#47"
    );
    // A devbox job tied to a PR still names its job.
    expect(
      holdDevFactOf(T.ciFinished, { ...job(0, "failure").data, pr: 47 })
    ).toBe("job:dev-feed-h");
  });

  it("null for a fact no hold can wait on", () => {
    expect(holdDevFactOf(T.prOpened, prRow(T.prOpened, 0).data)).toBeNull();
    expect(holdDevFactOf(T.repoSnapshot, snap(0, 0, "red").data)).toBeNull();
    expect(
      holdDevFactOf(T.ciFinished, {
        repo: BE,
        sha: "a",
        status: "success",
        workflow: "CI",
      })
    ).toBeNull();
    // Another workflow (Depends-On, the merge bot) is not the PR's checks.
    expect(
      holdDevFactOf(
        T.ciFinished,
        ci(0, "success", "green", { workflow: "Depends-On" }).data
      )
    ).toBeNull();
  });
});

describe("holdDevRefNamed", () => {
  it("names a dev fact in the hold line's words; a PR carries its GitHub page", () => {
    expect(holdDevRefNamed("pr:synap-core/backend#539")).toEqual({
      ref: { kind: "pr", repo: "synap-core/backend", number: 539 },
      label: "backend#539",
      url: "https://github.com/synap-core/backend/pull/539",
    });
    expect(holdDevRefNamed("main:synap-core/app-bases")).toMatchObject({
      label: "app-bases main",
      url: null,
    });
    expect(holdDevRefNamed("job:kit-h")).toMatchObject({
      label: "job kit-h",
      url: null,
    });
    expect(holdDevRefNamed("ai:available")).toEqual({
      ref: { kind: "ai" },
      label: "AI availability",
      url: null,
    });
  });

  it("names nothing that is not a dev fact", () => {
    expect(holdDevRefNamed("focus_session:abc")).toBeNull();
    expect(holdDevRefNamed("pr:not a repo#1")).toBeNull();
  });
});

describe("aiHoldMet", () => {
  const read = (availableMin: number | null, checkedMin: number) => ({
    availableSince: availableMin === null ? null : at(availableMin),
    checkedAt: at(checkedMin),
  });
  it("met while the latest pull reads available, checked after the pause began", () => {
    expect(aiHoldMet(SINCE, read(5, 6))).toBe(true);
    // Available since BEFORE the pause, checked after it: still met. The
    // transition may have been seen before the regrade could pass.
    expect(aiHoldMet(SINCE, read(-30, 6))).toBe(true);
    // An answer computed before (or at) the pause says nothing about it.
    expect(aiHoldMet(SINCE, read(-30, -5))).toBe(false);
    expect(aiHoldMet(SINCE, read(-30, 0))).toBe(false);
    // Not available now, never pulled, or a stamp that does not parse.
    expect(aiHoldMet(SINCE, read(null, 6))).toBe(false);
    expect(aiHoldMet(SINCE, null)).toBe(false);
    expect(aiHoldMet(SINCE, undefined)).toBe(false);
    expect(
      aiHoldMet(SINCE, { availableSince: at(5), checkedAt: "not a date" })
    ).toBe(false);
    expect(aiHoldMet("not a date", read(5, 6))).toBe(false);
  });
});
