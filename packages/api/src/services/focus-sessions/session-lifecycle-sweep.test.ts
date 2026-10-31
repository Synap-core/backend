/**
 * The waiting-on-merge hold (plan d679e92c C6): which PR a session waits on,
 * and the hold that the merge resumes. Pure halves only; the selection is the
 * SQL `onlyOpenPullRequestsWhere` (its own PGlite test, @synap/database).
 *
 * Fixtures rule out: "the first pull_request slot, whatever its state" (a
 * done or retired PR first in the list), "any url" (a repo url), and a hold
 * that names the PR in a spelling the dev-fact resume cannot match (the
 * `until.moves` must be the one `holdDevMovesRef` spelling, lowercased repo).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./complete-session.js", () => ({ completeFocusSession: vi.fn() }));
vi.mock("./session-path-sections.js", () => ({ attachNextMove: vi.fn() }));

import { parseHoldDevRef } from "@synap-core/types/lifecycle";
import {
  firstOpenPullRequest,
  waitingOnMergeHold,
} from "./session-lifecycle-sweep.js";

const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: "pull_request",
  label: `backend#${n}`,
  ref: { url: `https://github.com/Synap-core/backend/pull/${n}` },
  ...extra,
});

describe("firstOpenPullRequest", () => {
  it("skips a done, a retired and an optional PR, and a non-PR url", () => {
    expect(
      firstOpenPullRequest([
        pr(1, { status: "done" }),
        pr(2, { retiredAt: "" }),
        pr(3, { optional: true }),
        { kind: "pull_request", ref: { url: "https://github.com/a/b" } },
        pr(4),
      ])
    ).toEqual({ repo: "Synap-core/backend", number: 4 });
  });

  it("no outstanding PR, no hold", () => {
    expect(firstOpenPullRequest([pr(1, { status: "done" })])).toBeNull();
    expect(firstOpenPullRequest(null)).toBeNull();
  });
});

describe("waitingOnMergeHold", () => {
  it("waits on the PR in the one spelling the merge resume matches", () => {
    const hold = waitingOnMergeHold({ repo: "Synap-core/backend", number: 4 });
    expect(hold.on).toBe("external");
    expect(hold.until).toEqual({ moves: "pr:synap-core/backend#4" });
    expect(
      parseHoldDevRef((hold.until as { moves: string }).moves)
    ).toMatchObject({ kind: "pr", number: 4 });
  });
});
