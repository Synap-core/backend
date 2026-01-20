/**
 * Proposals Executor
 *
 * Handles validated proposal events.
 * Proposals are created by the validation system, so create events bypass validation.
 */

import { inngest } from "../client.js";
import { ProposalRepository } from "@synap/database";
import { getDb } from "@synap/database";

export const proposalsExecutor = inngest.createFunction(
  {
    id: "proposals-executor",
    name: "Proposals Executor",
    retries: 3,
  },
  [
    { event: "proposals.update.validated" },
    { event: "proposals.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-proposal-operation", async () => {
      const db = await getDb();
      const repo = new ProposalRepository(db as any);

      if (eventType === "proposals.update.validated") {
        // Approve or reject proposal
        const proposal = await repo.updateStatus(
          data.id,
          data.status,
          data.reviewedBy,
          data.reviewNotes
        );

        return {
          status: "completed",
          proposalId: proposal.id,
          message: `Proposal ${data.status}`,
        };
      }

      if (eventType === "proposals.delete.validated") {
        await repo.delete(data.id);

        return {
          status: "completed",
          proposalId: data.id,
          message: "Proposal deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
