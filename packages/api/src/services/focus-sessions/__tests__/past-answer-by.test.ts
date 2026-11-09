/**
 * A deadline already past is refused at write (review 5 Nov 2026): the pod
 * reads "overdue" as P0, the level whose push breaks through the person's
 * Focus, so a past `answerBy` would be a way around their push budget. The
 * update_session door (every client and ask_person) refuses it; a stored ask
 * whose time has since passed round-trips unchanged.
 */
import { describe, expect, it } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { pastAnswerByError, pastAnswerByLabels } from "../update-session.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const slot = (label: string, answerBy?: string): ExpectedOutput =>
  ({
    kind: "ask",
    label,
    owner: "human",
    blockedReason: "decision",
    ask: { mode: "confirm", ...(answerBy ? { answerBy } : {}) },
  }) as ExpectedOutput;

describe("pastAnswerByLabels — what the write door refuses", () => {
  it("a new ask with an answerBy in the past (or now) is refused, named by its label", () => {
    expect(
      pastAnswerByLabels([], [slot("Publish?", "2026-11-05T11:00:00Z")], NOW)
    ).toEqual(["Publish?"]);
    expect(
      pastAnswerByLabels([], [slot("Publish?", "2026-11-05T12:00:00Z")], NOW)
    ).toEqual(["Publish?"]);
  });

  it("a future answerBy, or none, is fine", () => {
    expect(
      pastAnswerByLabels(
        [],
        [slot("A", "2026-11-05T12:30:00Z"), slot("B")],
        NOW
      )
    ).toEqual([]);
  });

  it("the stored ask's own answerBy, round-tripped unchanged after it passed, is fine; a changed one is judged", () => {
    const stored = [slot("Publish?", "2026-11-05T09:00:00Z")];
    expect(
      pastAnswerByLabels(
        stored,
        [slot("Publish?", "2026-11-05T09:00:00Z")],
        NOW
      )
    ).toEqual([]);
    expect(
      pastAnswerByLabels(
        stored,
        [slot("Publish?", "2026-11-05T10:00:00Z")],
        NOW
      )
    ).toEqual(["Publish?"]);
  });

  it("the refusal says what to do and that nothing changed", () => {
    expect(pastAnswerByError(["Publish?"])).toMatch(
      /^Refused: "Publish\?": answerBy is already past.*Nothing was changed\.$/
    );
  });
});
