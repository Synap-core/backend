import { describe, it, expect } from "vitest";
import {
  moveOutcomeMessage,
  moveOutcomeOfError,
  moveOutcomeOfResult,
} from "./index.js";

// The shape a TRPCClientError carries: `data` = the pod's errorFormatter data.
const trpcError = (data: Record<string, unknown>, message = "msg") =>
  Object.assign(new Error(message), { data });

describe("move outcome", () => {
  it("results: updated → moved, proposed keeps its proposal", () => {
    expect(moveOutcomeOfResult({ status: "updated" })).toEqual({
      status: "moved",
    });
    expect(
      moveOutcomeOfResult({ status: "proposed", proposalId: "p1" })
    ).toEqual({
      status: "proposed",
      proposalId: "p1",
    });
    expect(moveOutcomeOfResult(null).status).toBe("failed");
  });

  it("a stale move names where the thing is now — from data, never the message", () => {
    const o = moveOutcomeOfError(
      trpcError(
        {
          code: "CONFLICT",
          reasonCode: "LIFECYCLE_STALE",
          currentStatus: "won",
        },
        'Stale status: expected "lead", it is now "lost".' // deliberately disagrees
      )
    );
    expect(o).toEqual({ status: "conflict", currentStatus: "won" });
    expect(
      moveOutcomeMessage(o, (k) => (k === "won" ? "Closed won" : k))
    ).toEqual({
      tone: "warning",
      text: "Moved meanwhile to Closed won",
    });
  });

  it("a CONFLICT without the stale reason is still a conflict, current unknown", () => {
    expect(moveOutcomeOfError(trpcError({ code: "CONFLICT" }))).toEqual({
      status: "conflict",
      currentStatus: null,
    });
    // Another CONFLICT kind's fields are not read as a status.
    expect(
      moveOutcomeOfError(trpcError({ code: "CONFLICT", currentStatus: "won" }))
    ).toEqual({ status: "conflict", currentStatus: null });
    expect(
      moveOutcomeMessage({ status: "conflict", currentStatus: null })!.text
    ).toBe("Moved meanwhile");
  });

  it("refused / denied / failed carry the pod's message; moved says nothing", () => {
    expect(
      moveOutcomeOfError(trpcError({ code: "BAD_REQUEST" }, "Unknown option"))
    ).toEqual({
      status: "refused",
      message: "Unknown option",
    });
    expect(
      moveOutcomeOfError(trpcError({ code: "FORBIDDEN" }, "Only a person"))
        .status
    ).toBe("denied");
    expect(moveOutcomeOfError(new Error("offline")).status).toBe("failed");
    expect(moveOutcomeMessage({ status: "moved" })).toBeNull();
    expect(
      moveOutcomeMessage({ status: "proposed", proposalId: null })!.text
    ).toBe("Sent for review");
  });
});
