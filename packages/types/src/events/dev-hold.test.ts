/**
 * Is the dev fact a hold waits on in? (`holdDevRefMet`) — and which hold ref a
 * just-recorded fact may resume (`holdDevFactOf`). Pure, over the rows the
 * hold-resume worker reads.
 */
import { describe, expect, it } from "vitest";

import { DEV_LOOP_EVENT_TYPES as T } from "./dev-loop.js";
import { holdDevFactOf, holdDevRefMet, holdDevRefNamed } from "./dev-hold.js";
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
  });

  it("names nothing that is not a dev fact", () => {
    expect(holdDevRefNamed("focus_session:abc")).toBeNull();
    expect(holdDevRefNamed("pr:not a repo#1")).toBeNull();
  });
});
