/**
 * Proposals Executor
 *
 * Handles validated proposal events.
 * Proposals are created by the validation system, so create events bypass validation.
 */

import { inngest } from "../client.js";
import { ProposalRepository, ProposalStatus } from "@synap/database";
import { getDb } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const proposalsExecutor = inngest.createFunction(
  {
    id: "proposals-executor",
    name: "Proposals Executor",
    retries: 3,
  },
  [
    { event: "proposal.*" },
  ],
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[proposalsExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-proposal-operation", async () => {
      const db = await getDb();
      const repo = new ProposalRepository(db);

      if (action === "update") {
        // Approve or reject proposal
        const status = data.status as ProposalStatus;
        if (
          status !== ProposalStatus.APPROVED &&
          status !== ProposalStatus.REJECTED
        ) {
          throw new Error(`Invalid proposal status: ${status}`);
        }
        const proposal = await repo.updateStatus(
          data.id as string,
          status,
          (data.reviewedBy as string | undefined) || "",
          data.reviewNotes as string | undefined
        );

        return {
          status: "completed",
          proposalId: proposal.id,
          message: `Proposal ${data.status as string}`,
        };
      }

      if (action === "delete") {
        await repo.delete(data.id as string);

        return {
          status: "completed",
          proposalId: data.id as string,
          message: "Proposal deleted successfully",
        };
      }

      throw new Error(`Unknown action: ${action}`);
    });
  }
);
