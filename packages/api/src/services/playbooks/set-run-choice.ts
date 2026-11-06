/**
 * Remember who runs a playbook for a person: the ONE governed write behind
 * tRPC `playbooks.setRunChoice` and Hub `PUT /playbooks/{id}/run-choice`
 * (run choice v3, decisions D6/D7).
 *
 *   - a person's choice applies (the assignment edge, `setRunChoice`) and the
 *     answer is the read the page draws next;
 *   - an agent or a third-party app (an agent key) may only ASK: the gate
 *     (`checkPermissionOrPropose`, `playbook/set_run_choice`, floored) files a
 *     proposal the person approves once, and its executor replays this write
 *     as the person (`governanceProposalId` set), so it applies.
 *
 * The playbook is loaded through `scopedDb`, the same visibility every
 * playbook door reads through, and a key is bounded by its grant
 * (`playbook.run`: choosing who runs it is part of running it).
 */

import type { PlaybookRunChoice, RunChoice } from "@synap-core/types/agents";
import { playbooks, type Playbook } from "@synap/database/schema";
import { eq } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { AccessContext, scopedDb } from "../../access/index.js";
import type { Context } from "../../context.js";
import { assertKeyMayWrite } from "../../utils/assert-key-may-write.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { setRunChoice } from "../agent-dispatch/agent-assignment.js";
import { readPlaybookRunChoice } from "./run-choice.js";

/** What the write door answers: applied with the new read, or proposed. */
export type SetRunChoiceResult =
  | {
      status: "applied";
      proposalId: null;
      message: null;
      runChoice: PlaybookRunChoice;
    }
  | {
      status: "proposed";
      proposalId: string;
      message: string;
      runChoice: null;
    };

/** The person's words when an agent's choice waits for them. */
export const RUN_CHOICE_PROPOSED_MESSAGE =
  "Saved once you approve it in your pod.";

export async function setPlaybookRunChoiceGoverned(
  ctx: Pick<Context, "userId" | "agentUserId" | "governanceProposalId"> &
    Parameters<typeof AccessContext.from>[0],
  input: { playbookId: string; choice: RunChoice; reasoning?: string }
): Promise<SetRunChoiceResult> {
  const userId = ctx.userId as string;
  const playbook = await scopedDb(AccessContext.from(ctx)).findFirst<Playbook>(
    playbooks,
    { where: eq(playbooks.id, input.playbookId) }
  );
  if (!playbook) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Playbook ${input.playbookId} not found`,
    });
  }
  await assertKeyMayWrite({
    subjectType: "playbook",
    action: "run",
    workspaceId: playbook.workspaceId ?? null,
  });
  if (
    input.choice.executor === "is-agent" &&
    playbook.executor === "external-agent"
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This process runs only on an agent, so Synap AI cannot run it: choose one of your agents.",
    });
  }
  // An agent's ask (D7). An approved replay comes back here as the approver,
  // with `governanceProposalId` set and no agent, so it applies.
  if (ctx.agentUserId && !ctx.governanceProposalId) {
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId: ctx.agentUserId,
      workspaceId: playbook.workspaceId ?? null,
      subjectType: "playbook",
      action: "set_run_choice",
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      data: {
        // The proposal's target is the playbook itself.
        id: playbook.id,
        playbookId: playbook.id,
        name: playbook.name,
        choice: input.choice,
        // Whose choice it is: only this person may approve it.
        ownerId: userId,
      },
    });
    if ("denied" in perm && perm.denied) {
      throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
    }
    if ("proposalId" in perm && perm.proposalId) {
      return {
        status: "proposed",
        proposalId: perm.proposalId,
        message: proposedMessageFor(
          perm.proposalType,
          RUN_CHOICE_PROPOSED_MESSAGE
        ),
        runChoice: null,
      };
    }
  }
  await setRunChoice({
    callerId: userId,
    playbookId: playbook.id,
    choice: input.choice,
  });
  return {
    status: "applied",
    proposalId: null,
    message: null,
    runChoice: await readPlaybookRunChoice({ userId, playbook }),
  };
}
