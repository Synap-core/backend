/**
 * "Draft a template for this kind" — the confirm of a `draft_process` route
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
 *
 * ── IDEMPOTENT per (workspace, kind) ────────────────────────────────────────
 * A confirm can be repeated (a persisted offer tapped again, a retry after an
 * unclear answer, two surfaces). It never files a second draft:
 *  - an open DRAFT playbook for the kind in the workspace is returned as the
 *    applied result (`deduped: true`, its id on the plan step);
 *  - otherwise the graph is filed under a stable idempotency key
 *    (`draft-process:<workspace>:<kind>[:<name>]`), so the capture-graph door
 *    returns the caller's PENDING (or auto-applied) draft proposal instead of a
 *    second one.
 * Limit, stated: an auto-applied draft that was since deleted keeps answering
 * with its old receipt; naming the draft differently files a new one.
 */

import {
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";
import { db, playbooks, and, eq, desc, drizzleSql } from "@synap/database";
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
    name:
      input.name?.trim() ||
      `${noun} ${resolveObjectNoun("playbook").toLowerCase()}`,
    description: `Drafted from a capture. Add the stages a ${lower} goes through, what each one produces, and when it is done.`,
    goalTemplate: `Move this ${lower} forward`,
    subjectProfile: {
      profileSlug: input.profileSlug,
      ...(input.statusProperty ? { statusProperty: input.statusProperty } : {}),
    },
    status: "draft" as const,
  };
}

/** The stable key a draft for (workspace, kind[, name]) is filed under. */
export function draftProcessIdempotencyKey(input: {
  workspaceId: string;
  profileSlug: string;
  name?: string | null;
}): string {
  const name = input.name?.trim();
  return `draft-process:${input.workspaceId}:${input.profileSlug}${name ? `:${name}` : ""}`;
}

export async function draftProcessForKind(input: {
  userId: string;
  agentUserId?: string | null;
  workspaceId: string;
  profileSlug: string;
  statusProperty?: string | null;
  name?: string | null;
}): Promise<SubmitCaptureGraphResult> {
  const summary = `Draft a ${resolveObjectNoun("playbook").toLowerCase()} for ${resolveObjectNounPlural(input.profileSlug).toLowerCase()}`;

  const [open] = await db
    .select({ id: playbooks.id, name: playbooks.name })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.workspaceId, input.workspaceId),
        eq(playbooks.status, "draft"),
        drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${input.profileSlug}`
      )
    )
    .orderBy(desc(playbooks.createdAt))
    .limit(1);
  if (open) {
    return {
      proposalId: undefined,
      entityCount: 0,
      relationCount: 0,
      bindingCount: 0,
      reviewUrl: undefined,
      summary,
      applied: true,
      deduped: true,
      plan: {
        steps: [
          {
            ref: DRAFT_PROCESS_REF,
            opIndex: 0,
            kind: "playbook",
            label: open.name,
            state: "applied",
            id: open.id,
          },
        ],
      },
      sessionId: null,
      scope: {
        workspaceId: input.workspaceId,
        projectId: null,
        sessionId: null,
      },
      writeReceipt: {
        state: "applied",
        effectiveWorkspaceId: input.workspaceId,
        source: "intelligence",
      },
    };
  }

  const op = buildDraftProcessOp(input);
  return submitCaptureGraph({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    workspaceId: input.workspaceId,
    entities: [],
    plan: { playbooks: [op] },
    summary,
    rawSource: { idempotencyKey: draftProcessIdempotencyKey(input) },
  });
}
