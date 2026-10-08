/**
 * "Draft a process for this" — the confirm of a `draft_process` route
 * suggestion (`routing/load-route-suggestions.ts`).
 *
 * Files ONE composite capture graph carrying a single `create_playbook` op
 * through the ONE capture-graph door (`submitCaptureGraph`), so it is governed
 * exactly like any other capture: the graph is scored op by op against the
 * agent policy (the strictest member decides — `capture-graph-policy.ts`), an
 * agent caller may auto-apply or propose, and a human/machine caller files a
 * pending proposal the person approves. On apply the materializer creates the
 * playbook through `playbooks.create`, ALWAYS `status: "draft"`.
 *
 * The draft is minimal on purpose: the kind, its lifecycle property, a one-line
 * goal. Stages, criteria and outputs are for the person / agent to complete on
 * the playbook's own page.
 */

import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  submitCaptureGraph,
  type SubmitCaptureGraphResult,
} from "./submit-capture-graph.js";

export const DRAFT_PROCESS_REF = "draft_process";

/** The op a draft is filed as. Pure — the executor test drives it. */
export function buildDraftProcessOp(input: {
  profileSlug: string;
  statusProperty?: string | null;
  name?: string | null;
}) {
  const noun = resolveObjectNoun(input.profileSlug);
  const lower = noun.toLowerCase();
  return {
    ref: DRAFT_PROCESS_REF,
    name: input.name?.trim() || `${noun} process`,
    description: `Drafted from a capture. Add the stages a ${lower} goes through, what each one produces, and when it is done.`,
    goalTemplate: `Move this ${lower} forward`,
    subjectProfile: {
      profileSlug: input.profileSlug,
      ...(input.statusProperty ? { statusProperty: input.statusProperty } : {}),
    },
    status: "draft" as const,
  };
}

export async function draftProcessForKind(input: {
  userId: string;
  agentUserId?: string | null;
  workspaceId: string;
  profileSlug: string;
  statusProperty?: string | null;
  name?: string | null;
  /** The capture that prompted it — threaded for provenance only. */
  sessionId?: string;
}): Promise<SubmitCaptureGraphResult> {
  const op = buildDraftProcessOp(input);
  return submitCaptureGraph({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    workspaceId: input.workspaceId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    entities: [],
    plan: { playbooks: [op] },
    summary: `Draft a process for ${resolveObjectNoun(input.profileSlug).toLowerCase()} items`,
  });
}
