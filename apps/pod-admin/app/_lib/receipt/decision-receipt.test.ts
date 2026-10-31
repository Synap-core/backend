import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { afterEach, describe, expect, it } from "vitest";
import {
  batchApproveReceipt,
  batchRejectReceipt,
  decisionFailure,
  decisionReceipt,
  readApproveAnswer,
  readRejectAnswer,
  undoFailureReceipt,
  undoReceipt,
} from "./decision-receipt";
import { fr } from "./copy";

afterEach(() => setAmbientCatalogLocale("en"));

const BANNED = /Error|Oops|Please|Sorry|Something went wrong|proposal|pod\b/;

function words(r: { title: string; description?: string }): string {
  return `${r.title} ${r.description ?? ""}`;
}

describe("readApproveAnswer: what the pod answered an approve", () => {
  it("applied only when the answer says it applied", () => {
    expect(readApproveAnswer({ success: true })).toEqual({
      state: "applied",
      verb: "approve",
    });
    expect(
      readApproveAnswer({
        success: true,
        effect: { applied: "verified" },
      }).state
    ).toBe("applied");
  });

  it("a no-op and an approve of an approved request change nothing", () => {
    expect(
      readApproveAnswer({ success: true, effect: { applied: "none" } })
    ).toEqual({ state: "no_effect", verb: "approve", already: false });
    expect(readApproveAnswer({ success: true, alreadyApproved: true })).toEqual(
      { state: "no_effect", verb: "approve", already: true }
    );
  });

  it("a partial application is not 'Request approved'", () => {
    expect(
      readApproveAnswer({
        success: true,
        refusals: ["The status stays as it is: a person moves it."],
      })
    ).toEqual({
      state: "partial",
      verb: "approve",
      left: 1,
      detail: "The status stays as it is: a person moves it.",
    });
    expect(
      readApproveAnswer({
        success: true,
        relationsFailed: [{ reason: "x" }, { reason: "y" }],
      })
    ).toEqual({ state: "partial", verb: "approve", left: 2 });
    const r = decisionReceipt(
      readApproveAnswer({ success: true, relationsFailed: [{}, {}] }),
      { revertable: true }
    );
    expect(r).toMatchObject({
      title: "Approved, but not all of it",
      description: "2 parts weren’t applied.",
      tone: "default",
      undo: true,
    });
    // A refusal that is not a sentence is counted, never shown.
    expect(
      decisionReceipt(
        readApproveAnswer({ success: true, refusals: ['{"code":"x"}'] })
      ).description
    ).toBe("1 part wasn’t applied.");
  });

  it("success false, or no success at all, is a failure", () => {
    expect(readApproveAnswer({ success: false }).state).toBe("failed");
    expect(readApproveAnswer({}).state).toBe("failed");
  });
});

describe("decisionReceipt: each outcome, its words", () => {
  it("an applied approve says so, with Undo only when the pod can take it back", () => {
    const outcome = readApproveAnswer({ success: true });
    const undoable = decisionReceipt(outcome, { revertable: true });
    expect(undoable).toMatchObject({
      title: "Request approved",
      tone: "success",
      undo: true,
    });
    expect(undoable.description).toMatch(/already sent stays sent/);

    for (const revertable of [false, null, undefined]) {
      const plain = decisionReceipt(outcome, { revertable });
      expect(plain).toEqual({
        title: "Request approved",
        tone: "success",
        undo: false,
      });
    }
  });

  it("an applied reject offers Undo (the request is reopened)", () => {
    const r = decisionReceipt(readRejectAnswer({ success: true }));
    expect(r).toMatchObject({ title: "Request rejected", undo: true });
  });

  it("nothing changed is said, never 'approved', and has no Undo", () => {
    const none = decisionReceipt(
      readApproveAnswer({ success: true, effect: { applied: "none" } }),
      { revertable: true }
    );
    expect(none).toMatchObject({
      title: "Approved, but nothing changed",
      undo: false,
    });
    const already = decisionReceipt(
      readApproveAnswer({ success: true, alreadyApproved: true }),
      { revertable: true }
    );
    expect(already.title).toBe("Already approved: nothing changed");
    expect(already.undo).toBe(false);
  });

  it("a failure's title is ours; the pod's sentence only when the refusal is typed", () => {
    const typed = decisionReceipt(
      decisionFailure("approve", {
        message: "This request changed after you opened it.",
        data: { code: "CONFLICT" },
      })
    );
    expect(typed).toEqual({
      title: "Couldn’t approve this request",
      description: "This request changed after you opened it.",
      tone: "danger",
      undo: false,
    });

    const internal = decisionReceipt(
      decisionFailure("reject", {
        message: 'relation "proposals" does not exist',
        data: { code: "INTERNAL_SERVER_ERROR" },
      })
    );
    expect(internal.title).toBe("Couldn’t reject this request");
    expect(internal.description).toBe("Nothing changed. Try again.");

    const raw = decisionReceipt(
      decisionFailure("approve", {
        message: '[{"code":"invalid_type","path":["proposalId"]}]',
        data: { code: "BAD_REQUEST" },
      })
    );
    expect(raw.description).toBe("Nothing changed. Try again.");

    const answered = decisionReceipt(readApproveAnswer({ success: false }));
    expect(answered).toMatchObject({ tone: "danger", undo: false });
  });

  it("never speaks our words or blame words", () => {
    const receipts = [
      decisionReceipt(readApproveAnswer({ success: true }), {
        revertable: true,
      }),
      decisionReceipt(readRejectAnswer({ success: true })),
      decisionReceipt(readApproveAnswer({ success: false })),
      decisionReceipt(readRejectAnswer({ success: false })),
      decisionReceipt(
        readApproveAnswer({ success: true, effect: { applied: "none" } })
      ),
      undoReceipt({ success: true }),
      undoReceipt({ success: false }),
      undoReceipt({ success: false, nothingReverted: true }),
      undoFailureReceipt({
        message: "boom",
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
      batchRejectReceipt(3, 2),
      batchRejectReceipt(3, 0),
      batchApproveReceipt({ approved: 2, failed: 1 }),
      batchApproveReceipt({ approved: 0, failed: 2 }),
      decisionReceipt(readApproveAnswer({ success: true, refusals: ["x y"] })),
    ];
    for (const r of receipts) expect(words(r)).not.toMatch(BANNED);
  });
});

describe("undoReceipt: what the pod answered an Undo", () => {
  it("undone, partly, nothing, failed", () => {
    expect(undoReceipt({ success: true })).toMatchObject({
      title: "Decision undone",
      tone: "success",
    });
    expect(
      undoReceipt({ success: true, alreadyReverted: true } as never).title
    ).toBe("Decision undone");
    expect(
      undoReceipt({ success: true, partialFailures: ["a note (changed)"] })
        .title
    ).toBe("Partly undone");
    expect(
      undoReceipt({ success: true, skipped: [{ reason: "edited" }] }).title
    ).toBe("Partly undone");
    // `proposals.revert` answers `success: false` when some of it is still
    // live and the rest came back: a partial Undo, not a failed one.
    expect(
      undoReceipt({ success: false, partialFailures: ["Task (changed)"] })
    ).toMatchObject({ title: "Partly undone", tone: "default" });
    expect(undoReceipt({ success: false }).title).toBe("Partly undone");
    expect(undoReceipt({ success: false, nothingReverted: true }).title).toBe(
      "Nothing was undone"
    );
    // Only an Undo that threw failed.
    expect(
      undoFailureReceipt({ message: "boom", data: { code: "TIMEOUT" } })
    ).toMatchObject({ title: "Couldn’t undo this decision", tone: "danger" });
  });

  it("says what Undo cannot bring back", () => {
    expect(
      undoReceipt({
        success: true,
        permanent: { reason: "external_dispatched" },
      }).description
    ).toMatch(/already sent stays sent/);
  });

  it("an Undo is never itself undoable", () => {
    expect(undoReceipt({ success: true }).undo).toBe(false);
  });
});

describe("batchRejectReceipt: counts the pod's answer, not the rows picked", () => {
  it("all of them", () => {
    expect(batchRejectReceipt(3, 3)).toMatchObject({
      title: "Rejected 3 requests",
    });
    expect(batchRejectReceipt(1, 1).title).toBe("Rejected 1 request");
  });

  it("some of them, and why the rest were not", () => {
    const r = batchRejectReceipt(3, 2);
    expect(r.title).toBe("Rejected 2 of 3 requests");
    expect(r.description).toBe("1 was already decided or withdrawn.");
  });

  it("none of them is never 'Rejected 3'", () => {
    const r = batchRejectReceipt(3, 0);
    expect(r.title).toBe("Nothing rejected");
    expect(r.description).toBe("3 were already decided or withdrawn.");
  });
});

describe("batchApproveReceipt: per row, like the page lists them", () => {
  it("all, some, none", () => {
    expect(batchApproveReceipt({ approved: 2, failed: 0 })).toMatchObject({
      title: "Approved 2 requests",
      tone: "success",
    });
    expect(batchApproveReceipt({ approved: 1, failed: 0 }).title).toBe(
      "Approved 1 request"
    );
    const some = batchApproveReceipt({ approved: 2, failed: 1 });
    expect(some.title).toBe("Approved 2 of 3 requests");
    expect(some.description).toMatch(/^1 couldn’t be approved/);
    expect(some.tone).toBe("default");
    // Nothing approved is a failure: it waits until it is closed.
    expect(batchApproveReceipt({ approved: 0, failed: 2 })).toMatchObject({
      title: "Nothing approved",
      tone: "danger",
    });
  });
});

describe("batch counts in French agree with their number", () => {
  it("one request is singular", () => {
    setAmbientCatalogLocale("fr");
    expect(batchRejectReceipt(3, 1).title).toBe("1 demande refusée sur 3");
    expect(batchApproveReceipt({ approved: 1, failed: 2 }).title).toBe(
      "1 demande approuvée sur 3"
    );
  });
});

describe("the reject verb is the vocabulary door's, in French too", () => {
  it("every reject receipt says the door's verb, never a twin", () => {
    // The door's past verb ("Rejeté"), without its ending: the receipt
    // agrees it with "demande".
    const stem = resolveActionLabel("reject", "past", "fr")
      .toLowerCase()
      .slice(0, -1);
    const rejectKeys = (Object.keys(fr) as Array<keyof typeof fr>).filter(
      (k) => /^(reject|batchReject)\./.test(k) && !/Hint$/.test(k)
    );
    expect(rejectKeys.length).toBeGreaterThan(3);
    for (const k of rejectKeys) {
      expect(fr[k].toLowerCase(), k).toContain(stem);
      expect(fr[k], k).not.toMatch(/refus/i);
    }
  });
});
