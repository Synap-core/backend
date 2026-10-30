/**
 * Session-start recall's preference for the session's own focus reads the ONE
 * lens signal (`lensAffinity`), not its own workspace equality test: the
 * session's workspace, a pod-wide row homed there, and its project's members
 * all count, in that order, and none of it can lift an item over the floor.
 */
import { describe, it, expect } from "vitest";
import { selectRecalled, type RecallCandidate } from "./session-recall.js";

const NOW = new Date("2026-10-29T12:00:00Z");
const WS = "ws-session";

// Equal evidence everywhere: the same semantic score, no lexical overlap.
const cand = (id: string, over: Partial<RecallCandidate> = {}) => ({
  id,
  title: id,
  type: "knowledge",
  workspaceId: "ws-elsewhere",
  text: "",
  semantic: 0.6,
  ...over,
});

const select = (
  candidates: RecallCandidate[],
  focus: Parameters<typeof selectRecalled>[0]["focus"]
) =>
  selectRecalled({
    query: "release plan",
    candidates,
    excludeIds: new Set(),
    focus,
    now: NOW,
  });

describe("selectRecalled — the session's focus is a preference, via lensAffinity", () => {
  it("prefers workspace > home workspace > project member > elsewhere; none dropped", () => {
    const got = select(
      [
        cand("elsewhere"),
        cand("member"),
        cand("homed", { workspaceId: null, homeWorkspaceId: WS }),
        cand("in-space", { workspaceId: WS }),
      ],
      { workspaceId: WS, projectIds: new Set(["member"]) }
    );
    expect(got.map((i) => i.entityId)).toEqual([
      "in-space",
      "homed",
      "member",
      "elsewhere",
    ]);
  });

  it("the preference never lifts an item over the evidence floor", () => {
    const got = select([cand("weak", { workspaceId: WS, semantic: 0.34 })], {
      workspaceId: WS,
    });
    expect(got).toEqual([]);
  });

  it("no focus: equal items keep their pool order", () => {
    const got = select([cand("a"), cand("b", { workspaceId: WS })], null);
    expect(got.map((i) => i.entityId)).toEqual(["a", "b"]);
  });
});
