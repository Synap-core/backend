/**
 * CAN THIS PROPOSAL APPLY? The ONE check per proposal kind, asked where every
 * door files (plan 8032a127 D1, option C; founder, 17 Nov 2026).
 *
 * `createPendingProposalRow` (permission-check.ts) calls
 * {@link proposalCannotApply} before the row is inserted, so every API door
 * that files a pending proposal (`createProposal` behind
 * `checkPermissionOrPropose`, `createPendingProposal`,
 * `createEventBackedProposal`) is checked by existing. A revision of a
 * pending payload asks the same check (`checkRevisedPayload`,
 * proposals-service.ts). Each entry calls the function its APPROVAL runs, so
 * the two cannot drift (tripwire `filing-and-approval-share-the-check`); the
 * approval keeps its own call, which decides when the world moved between the
 * filing and the yes.
 *
 * Three outcomes, by who can act:
 *   - REFUSE what the agent can fix alone: nothing is filed, the caller gets
 *     the approval's own sentence and a code (an entry below);
 *   - HOLD what only the person can unblock: filed pending with what it waits
 *     on. A hold decides the door's ROUTE (a held send is filed instead of
 *     run), so it is read in its door, before the gate: the LinkedIn reach
 *     (`reachHoldAtFiling`, which calls a provider and so cannot run inside
 *     the filing transaction) and the install setup (`proposal-setup.ts`,
 *     derived on every read, never stored). One projection reads both:
 *     `cannotApplyYet` in `@synap-core/types/proposals/cannot-apply`;
 *   - FILE as today what the reviewer decides (a same-name record: the
 *     duplicate door files it with `duplicateCheck`) and every kind with no
 *     entry.
 *
 * An entry reads the pod's own database only. `createProposal` and
 * `createEventBackedProposal` ask it BEFORE their transaction and their
 * `.requested` event; `createPendingProposalRow` asks it for every other
 * caller, inside the caller's transaction when there is one (`reader`). A
 * read that FAILS files as before (an entry that throws is logged and filed):
 * never refuse on a fact not read.
 *
 * Doors that file WITHOUT this check (they insert through
 * `insertPendingProposal` in @synap/jobs, which cannot import @synap/api):
 *   - `playbook-lessons-scanner.ts` files `playbook/update` (a stage-lessons
 *     revision built from the stored playbook, never an agent's definition);
 *   - `automation-governance.ts` (`checkAutomationWriteOrPropose`) files an
 *     automation's write of any kind; a slot list on a session update is
 *     checked by `fileableExpectedOutputs` before it.
 *
 * Keyed like the approve executors (`execution-registry.ts`): the exact
 * `${targetType}/${proposalType}`, then the bare `proposalType`.
 */

import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { isNestedEnvelope } from "@synap-core/types/proposals";

const logger = createLogger({ module: "proposal-can-apply" });

/** What the check reads of a proposal about to be filed (or revised). */
export interface CanApplyInput {
  targetType: string;
  targetId: string;
  proposalType: string;
  /** The stored `proposals.data` (request envelope or flat payload). */
  data: Record<string, unknown>;
  /** The person whose data is in scope (the row's owner). */
  userId: string;
  workspaceId: string | null;
  agentUserId?: string | null;
  sessionId?: string | null;
  /**
   * The filing transaction, when the door files inside one: an entry's own
   * reads go through it (a read beside an open transaction waits on it on a
   * single-connection database). Absent = the pool.
   */
  reader?: CanApplyReader;
}

/** What an entry reads with: the pool, or the filing transaction. */
export type CanApplyReader = Pick<
  typeof import("@synap/database").db,
  "select"
>;

/** Why it cannot apply: the approval's own sentence, and a stable code. */
export interface CanApplyRefusal {
  reasonCode: string;
  message: string;
}

type CanApplyCheck = (
  payload: Record<string, unknown>,
  input: CanApplyInput
) => Promise<CanApplyRefusal | null>;

/** A playbook payload the approval's replay (`playbooks.create` / `.update`) refuses. */
async function playbookRefusal(
  changeType: "create" | "update",
  payload: Record<string, unknown>
): Promise<CanApplyRefusal | null> {
  const { assertRevisedPlaybookPayload } =
    await import("../../routers/playbooks.js");
  const { UnknownProfileSlugError } =
    await import("../../utils/assert-known-profile-slug.js");
  try {
    await assertRevisedPlaybookPayload(changeType, payload);
    return null;
  } catch (err) {
    // A refusal is the definition check's BAD_REQUEST, or its NOT_FOUND for a
    // `subjectProfile` naming no kind (`UnknownProfileSlugError`, only that
    // shape); anything else is a read that failed, and files as before.
    if (
      (err instanceof TRPCError && err.code === "BAD_REQUEST") ||
      err instanceof UnknownProfileSlugError
    ) {
      return { reasonCode: "INVALID_PLAYBOOK", message: err.message };
    }
    throw err;
  }
}

/**
 * The entries. Each calls the function its approval runs:
 *   capability.run       → `recipeRunRefusalAtFiling` → `planRecipeRun`, which
 *                          the approval's `queueRecipeRun` runs (a recipe run
 *                          only; every other capability files as before)
 *   playbook/create|update → `assertRevisedPlaybookPayload` → the definition
 *                          check `playbooks.create` / `.update` run when the
 *                          approval replays them
 *   command/execute      → `commandPolicyRefusal`, which the materializer
 *                          runs before it executes
 *   focus_session/update → `detectServerStampedWrites`, which the approval's
 *                          `mergeExpectedOutputs` runs (a slot list only)
 */
const CAN_APPLY: Readonly<Record<string, CanApplyCheck>> = {
  "capability.run": async (payload, input) => {
    const skillId = payload.skillId;
    if (typeof skillId !== "string") return null;
    const { db, skills, eq } = await import("@synap/database");
    const [skill] = await (input.reader ?? db)
      .select({ id: skills.id, name: skills.name, kind: skills.kind })
      .from(skills)
      .where(eq(skills.id, skillId))
      .limit(1);
    const { RUN_RECIPE_VERB } =
      await import("../host-jobs/hosted-verb-rules.js");
    if (!skill || skill.kind !== "builtin" || skill.name !== RUN_RECIPE_VERB)
      return null;
    const { recipeRunRefusalAtFiling } =
      await import("../capabilities/builtin-verbs.js");
    const parameters =
      payload.parameters && typeof payload.parameters === "object"
        ? (payload.parameters as Record<string, unknown>)
        : {};
    return recipeRunRefusalAtFiling(parameters, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentUserId: input.agentUserId ?? null,
      sessionId: input.sessionId ?? null,
      verbId: skill.id,
      verbName: skill.name,
    });
  },
  "playbook/create": (payload) => playbookRefusal("create", payload),
  "playbook/update": (payload) => playbookRefusal("update", payload),
  "command/execute": async (payload) => {
    const { commandPolicyRefusal } = await import("@synap/governance-policy");
    const refusal = commandPolicyRefusal(payload.command);
    return refusal ? { reasonCode: "COMMAND_REFUSED", message: refusal } : null;
  },
  "focus_session/update": async (payload, input) => {
    if (!Array.isArray(payload.expectedOutputs)) return null;
    const { db, focusSessions, eq } = await import("@synap/database");
    const [session] = await (input.reader ?? db)
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, input.targetId))
      .limit(1);
    // No row: the approval says so; nothing to compare a stamp against.
    if (!session) return null;
    const { detectServerStampedWrites, serverStampedWriteError } =
      await import("../focus-sessions/update-session.js");
    type Slots = Parameters<typeof detectServerStampedWrites>[0];
    const violations = detectServerStampedWrites(
      (Array.isArray(session.expectedOutputs)
        ? session.expectedOutputs
        : []) as Slots,
      payload.expectedOutputs as Slots
    );
    return violations.length > 0
      ? {
          reasonCode: "SERVER_STAMPED_FIELD",
          message: serverStampedWriteError(violations).message,
        }
      : null;
  },
};

/** The entry for a proposal kind, keyed like the approve executors. */
function canApplyCheckFor(
  targetType: string,
  proposalType: string
): CanApplyCheck | undefined {
  return CAN_APPLY[`${targetType}/${proposalType}`] ?? CAN_APPLY[proposalType];
}

/** Whether this kind of proposal has an entry (a revision of it is judged). */
export function isCheckedProposalKind(
  targetType: string,
  proposalType: string
): boolean {
  return canApplyCheckFor(targetType, proposalType) !== undefined;
}

/** The fields the approval reads: the envelope's inner `data`, else the flat payload. */
function payloadOf(data: Record<string, unknown>): Record<string, unknown> {
  return (isNestedEnvelope(data) ? data.data : data) as Record<string, unknown>;
}

/**
 * THE check. `null` = file it (it can apply, it has no entry, or a read
 * failed); a refusal = nothing may be filed, the caller gets why.
 */
export async function proposalCannotApply(
  input: CanApplyInput
): Promise<CanApplyRefusal | null> {
  const check = canApplyCheckFor(input.targetType, input.proposalType);
  if (!check) return null;
  try {
    return await check(payloadOf(input.data), input);
  } catch (err) {
    logger.warn(
      {
        err,
        targetType: input.targetType,
        proposalType: input.proposalType,
      },
      "the filing check could not read; filed as before"
    );
    return null;
  }
}

/**
 * The refusal as the filing door throws it: a caller error (BAD_REQUEST, the
 * sentence on the wire) that carries its code. `createProposal` and
 * `executeCapability` turn it into their own denial ({@link filingRefusalOf});
 * every other door surfaces it as the 400 it is.
 */
export class ProposalCannotApplyError extends TRPCError {
  readonly reasonCode: string;
  constructor(refusal: CanApplyRefusal) {
    super({ code: "BAD_REQUEST", message: refusal.message });
    this.name = "ProposalCannotApplyError";
    this.reasonCode = refusal.reasonCode;
  }
}

/** The refusal a filing threw, or null for any other error. */
export function filingRefusalOf(err: unknown): CanApplyRefusal | null {
  return err instanceof ProposalCannotApplyError
    ? { reasonCode: err.reasonCode, message: err.message }
    : null;
}
