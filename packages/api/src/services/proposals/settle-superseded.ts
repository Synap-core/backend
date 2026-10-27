/**
 * The rest of a withdrawal, for the older versions a newer agent proposal
 * REPLACED. The supersede (`insertPendingProposal`, @synap/database) already
 * stamped them `withdrawn` + `reviewedAt` and actioned their bell rows in its
 * transaction; this runs, after the commit, the two side effects the person's
 * own withdraw door runs (`proposals.withdraw`) and that package cannot:
 *   - a staged source blob is discarded — a withdrawn proposal is terminal,
 *     so nothing else would ever decide its fate;
 *   - the live queue drops the row (`emitProposalReviewed` "withdrawn").
 *
 * Never throws: the replacement already stands, and a failed cleanup must not
 * turn a filed proposal into an error.
 */
import type { SupersededVersion } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "settle-superseded" });

export async function settleSupersededProposals(
  versions: readonly SupersededVersion[] | undefined,
  /** The person the proposal is filed for — the withdraw door's `userId`. */
  userId: string
): Promise<void> {
  if (!versions || versions.length === 0) return;
  // Imported here: both modules sit above the governance door that calls this.
  const [{ db }, { discardProposalSourceBlob }, { emitProposalReviewed }] =
    await Promise.all([
      import("@synap/database"),
      import("../../utils/store-entity-source-blob.js"),
      import("../../routers/proposals/apply-approval.js"),
    ]);
  for (const version of versions) {
    try {
      await discardProposalSourceBlob({
        database: db,
        userId,
        proposalData: version.data,
      });
    } catch (err) {
      logger.warn(
        { err, proposalId: version.id },
        "superseded proposal: staged source blob not discarded"
      );
    }
    emitProposalReviewed(version.id, version.workspaceId, "withdrawn", userId);
  }
}
