/**
 * A1 at the PROPOSAL door: `deriveProposalProjectId` (what `insertPendingProposal`
 * and the permission-check receipt both call) must FORWARD `sessionSource` to the
 * one ladder. A derived session still GROUPS the row, but gives it no project.
 *
 * Driven through the real adapter + real ladder with a mock executor whose
 * session row IS project-scoped, so the two cases differ only in `sessionSource`.
 * Does NOT cover `insertPendingProposal`'s own call site forwarding the field
 * (that needs the insert; see the api PGlite test).
 */
import { describe, it, expect } from "vitest";
import { deriveProposalProjectId } from "./insert-pending-proposal.js";

const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PROJ_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function executor(): any {
  return {
    query: {
      focusSessions: { findFirst: async () => ({ projectId: PROJ_A }) },
      channels: { findFirst: async () => undefined },
      relations: { findMany: async () => [] },
    },
  };
}

describe("deriveProposalProjectId — sessionSource reaches the ladder", () => {
  it("an explicit session files the proposal into its project", async () => {
    expect(
      await deriveProposalProjectId(
        { sessionId: SESSION, sessionSource: "explicit" },
        executor()
      )
    ).toBe(PROJ_A);
  });

  it("a DERIVED session gives the proposal no project", async () => {
    expect(
      await deriveProposalProjectId(
        { sessionId: SESSION, sessionSource: "derived" },
        executor()
      )
    ).toBeNull();
  });
});
