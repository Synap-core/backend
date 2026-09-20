/**
 * FOLLOW A PLAYBOOK — bind a LIVE session to a playbook, or release it.
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 * A session that follows a playbook BECOMES A RUN of it: `playbookId` is
 * written, so `projectSessionKind` (`session-kind.ts`) reclassifies the row
 * from `work` to `run`, it joins that playbook's runs feed, and it leaves the
 * owner's default work lens. That is the founder's decision — "so we can easily
 * get every run of one playbook" — and it is the reason the UI contract
 * requires the consequence to be DISCLOSED before the act rather than explained
 * afterwards.
 *
 * It is NOT an instantiate. `instantiateSessionRow` (`playbook-lifecycle.ts`)
 * INSERTs a row built from the definition: it rebuilds `title`/`goal` from the
 * playbook name, stamps `origin: "playbook"`, COPIES `expectedOutputs`
 * wholesale and seeds `currentStage` from the first stage. Every one of those
 * is correct at birth and wrong mid-flight, so none of them happens here:
 *
 *   - `title` / `goal` / `origin` are NEVER rewritten. `goal` is the dedup key
 *     (`findOpenSessionTwin`, the advisory lock in `create-session.ts`), so
 *     rewriting it silently changes what dedups against what; `origin` answers
 *     "what shaped this row" and a person opened it — that stays true.
 *   - `expectedOutputs` and `criteria` MERGE through the two helpers that
 *     already exist (`mergeExpectedOutputs` by label, `mergeCriteria` by key).
 *     A wholesale copy would destroy live human-owned blocked slots and their
 *     `owedSince` clocks — the deliverables a person is actually waiting on.
 *   - `currentStage` is NEVER auto-seeded. The caller NAMES the stage the work
 *     is already in (`followStageKey`) or the session stays at NULL. Seeding
 *     stage 1 onto half-done work is Jira's unmapped-status failure, shipped by
 *     someone else already: an issue whose status does not exist in the new
 *     workflow becomes hidden from most views and cannot be transitioned.
 *
 * ── The definition is PINNED ────────────────────────────────────────────────
 * The `playbook_runs` row is minted WITH a `definitionSnapshot`, because
 * `resolveStageGateForSession` (`playbooks/stage-gate.ts`) reads the snapshot
 * FIRST and falls back to the live `playbooks.stages` row when there is none.
 * Without a snapshot an edit to the playbook could add or remove a gate under a
 * session already running — Temporal's lesson (an in-flight execution keeps its
 * own definition), and the same reason `create-session.ts` snapshots.
 *
 * ── The grant widening is GOVERNED ──────────────────────────────────────────
 * A playbook's granted capabilities are read AT RUN TIME from its `grants`
 * links (`playbook-lifecycle.ts` header, `run-playbook.ts`), never copied. So
 * attaching silently widens what the session may call — no copy, no record, no
 * review. That widening goes through `checkPermissionOrPropose` with the SAME
 * `focus_session/grant_capability` subject+action the explicit
 * `focusSessions.grantCapability` door uses, and a `propose` verdict REFUSES
 * the attach rather than performing it and filing a note about it.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  focusSessions,
  playbooks,
  playbookRuns,
  proposals,
  ProposalStatus,
  eq,
  and,
  desc,
  drizzleSql,
} from "@synap/database";
import type { FocusSession } from "@synap/database";
import {
  collectPlaybookCriteria,
  mergeCriteria,
  readCriteria,
  readPlaybookParams,
  validatePlaybookParams,
  type ExpectedOutput,
  type PlaybookStage,
  type SessionCriterion,
} from "@synap/playbooks";
import {
  CHECK_GATE_METADATA_KEY,
  PARAM_SLOT_KIND,
} from "@synap-core/types/focus-sessions";
import { RUN_PARAMS_METADATA_KEY } from "../playbooks/playbook-lifecycle.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  createLinks,
  resolveGrantedCapabilities,
  getLinksFor,
} from "../links/links-service.js";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";
import {
  guidanceForBlockedSlots,
  newlyBlockedSlots,
  type BlockGuidance,
} from "./block-guidelines.js";
import {
  mergeExpectedOutputs,
  sanitizeDeclaredOutputs,
} from "./update-session.js";
import { STAGE_GATE_TARGET_TYPE } from "../playbooks/stage-gate.js";
import { buildDefinitionSnapshot } from "../playbooks/run-playbook.js";

/** Where the follow receipt lives on `focus_sessions.metadata`. */
export const FOLLOWED_AT_METADATA_KEY = "followedAt";
/** How the session came to follow its playbook — `"attach"` is this door. */
export const FOLLOWED_VIA_METADATA_KEY = "followedVia";
/** Stamped on release; the `followedAt` stays, because it happened. */
export const UNFOLLOWED_AT_METADATA_KEY = "unfollowedAt";
/** The only value this door writes for {@link FOLLOWED_VIA_METADATA_KEY}. */
export const FOLLOWED_VIA_ATTACH = "attach";

/**
 * What the door DID, as the UIs must render it.
 *
 * `mergedCriteria` / `mergedOutputs` mean two different (and both stated)
 * things depending on `action`, which is why `action` is on the wire rather
 * than inferred: on `attached` they are the numbers ADDED by the playbook; on
 * `detached` they are the numbers KEPT (the session's totals), because the
 * structure a person may already have graded is not deleted on release.
 */
export interface FollowOutcome {
  action: "attached" | "detached";
  /** Attach: the playbook now followed. Detach: always `null` — nothing is. */
  playbookId: string | null;
  /** The playbook's name — attach: the new one; detach: the one released. */
  playbookName: string | null;
  /** The stage this session is in. NULL unless the caller NAMED one. */
  stageKey: string | null;
  /** Attach: `true` — the row is a run now. Detach: `false`. */
  becameRun: boolean;
  mergedCriteria: number;
  mergedOutputs: number;
  /** The `playbook_runs` row this attach minted, or the one detach closed. */
  runId: string | null;
  /** One sentence for the caller — present when there is something to say. */
  note?: string;
  /**
   * The work-guideline safety net, for a slot this attach handed to the HUMAN.
   *
   * A playbook may declare a deliverable `owner: "human"` with a
   * `blockedReason`, so merging its slots in CAN block work on a person — and
   * the rule this codebase pays for is that a door which does that must say
   * whether standing guidance already covers it. Absent when nothing was newly
   * blocked, or when the lookup itself could not run (see
   * `guidanceForBlockedSlots`: unavailable ≠ nothing applies).
   */
  blockGuidelines?: BlockGuidance;
}

export type FollowPlaybookResult =
  | { status: "ok"; session: FocusSession; follow: FollowOutcome }
  | { status: "not_found" }
  | { status: "refused"; reason: string }
  | {
      status: "proposed";
      proposalId: string;
      proposalType?: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
      reason: string;
    };

export interface FollowPlaybookParams {
  sessionId: string;
  /** Owner floor — the same scoping every session door applies. */
  userId: string;
  agentUserId?: string;
  /** The playbook to follow; `null` RELEASES the current one. */
  followPlaybookId: string | null;
  /**
   * Which stage this work is ALREADY in. Absent (or `null`) ⇒ `currentStage`
   * stays as it is. A key the playbook does not declare is REFUSED with the
   * valid keys listed — never silently ignored, never mapped to stage 1.
   */
  followStageKey?: string | null;
  /**
   * Answers to the playbook's declared params. Until this existed the door
   * could not accept them AT ALL — a live session could be made a run of a
   * parameterised playbook while remembering nothing about what it was for.
   *
   * They are validated with the SAME pure function the run funnel uses
   * (`validatePlaybookParams`), stored on `metadata.params` under the same key
   * (`RUN_PARAMS_METADATA_KEY`) and MERGED over whatever the session already
   * carried, so following twice (or following after a `start` that supplied
   * some) accumulates rather than replaces.
   *
   * An unanswered REQUIRED param becomes an owed slot, never a refusal, for the
   * same reason it does on the start door: this session's instruction is its
   * own `goal`, not the playbook's rendered template, so nothing is mutilated
   * by the gap. A MISTYPED value IS refused — that is a malformed call.
   */
  params?: Record<string, unknown>;
}

function stageKeysOf(playbook: { stages: unknown }): string[] {
  const stages = Array.isArray(playbook.stages)
    ? (playbook.stages as PlaybookStage[])
    : [];
  return stages.map((s) => s?.key).filter((k): k is string => !!k);
}

/**
 * Is a stage gate waiting on a person for this session?
 *
 * TWO shapes, both checked, because the two gate kinds record themselves
 * differently and a caller told "no gate" by a check that only knows one of
 * them is the calm-confident-wrong answer this codebase keeps paying for:
 *   - a HUMAN gate is a PENDING proposal targeting the session
 *     (`openStageGate` → `STAGE_GATE_TARGET_TYPE` + `action: "stage_gate"`);
 *   - a CHECK gate is `metadata.checkGate` on the row (`applyCheckGate`),
 *     cleared by `resumeCheckGateIfMet`.
 */
export async function pendingStageGate(session: {
  id: string;
  metadata: unknown;
}): Promise<"human" | "check" | null> {
  const bag = (session.metadata ?? {}) as Record<string, unknown>;
  if (bag[CHECK_GATE_METADATA_KEY] != null) return "check";
  const [open] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, STAGE_GATE_TARGET_TYPE),
        eq(proposals.targetId, session.id),
        eq(proposals.status, ProposalStatus.PENDING),
        // `changeType`, not `proposalType`: a stage may OVERRIDE its gate's
        // proposal type (`stageGateProposalType(gate)` returns
        // `gate.proposalType` when the author set one), so matching the
        // DEFAULT type would be blind to exactly the custom-gated playbook a
        // person is most likely to have configured. `changeType: "stage_gate"`
        // is written unconditionally by `openStageGate`.
        drizzleSql`${proposals.data} ->> 'changeType' = 'stage_gate'`
      )
    )
    .limit(1);
  return open ? "human" : null;
}

/** The playbook's slots that the session does not already carry, by label. */
function newSlotsFrom(
  playbook: { expectedOutputs: unknown },
  current: ExpectedOutput[]
): ExpectedOutput[] {
  const have = new Set(
    current.map((o) => normalizeExpectedLabel(o?.label)).filter(Boolean)
  );
  const fromPlaybook = Array.isArray(playbook.expectedOutputs)
    ? (playbook.expectedOutputs as ExpectedOutput[])
    : [];
  return sanitizeDeclaredOutputs(
    fromPlaybook.filter((o) => {
      const key = normalizeExpectedLabel(o?.label);
      return !!key && !have.has(key);
    })
  );
}

/**
 * ATTACH or RELEASE. The ONE implementation behind all three doors (tRPC
 * `focusSessions.update`, Hub REST PATCH, MCP `synap_update_session`) and the
 * `focus_session/update` proposal executor — never a fourth copy.
 *
 * Runs AFTER the door's own field write, and takes its own row lock: the merge
 * must read the criteria and deliverables the SAME call may just have changed,
 * so the caller's explicit list lands first and the playbook's merges on top
 * (`mergeCriteria(own, template)` — the caller's wording wins).
 */
export async function followPlaybook(
  params: FollowPlaybookParams
): Promise<FollowPlaybookResult> {
  const { sessionId, userId, agentUserId, followPlaybookId } = params;

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
  });
  if (!session) return { status: "not_found" };

  if (followPlaybookId === null) {
    return releasePlaybook(session);
  }

  if (params.followStageKey != null && params.followStageKey.trim() === "") {
    return {
      status: "refused",
      reason:
        "followStageKey must name a stage — pass the stage `key`, or omit it to leave the session in no stage.",
    };
  }

  // VISIBILITY FLOOR. Load by id AND the user's workspace lens in one query, so
  // an invisible playbook is indistinguishable from a missing one.
  const [playbook] = await db
    .select()
    .from(playbooks)
    .where(
      and(
        eq(playbooks.id, followPlaybookId),
        userVisibleWhere(playbooks.workspaceId, userId)
      )
    )
    .limit(1);
  if (!playbook) {
    return {
      status: "refused",
      reason: `No playbook ${followPlaybookId} you can access.`,
    };
  }
  // The write-side IDOR floor `resolveRunnablePlaybook` applies, stated here
  // rather than borrowed: a workspace-scoped playbook may not be bound to a
  // session living in a different workspace.
  if (
    playbook.workspaceId &&
    session.workspaceId &&
    playbook.workspaceId !== session.workspaceId
  ) {
    return {
      status: "refused",
      reason: `Playbook ${playbook.id} belongs to another workspace than this session.`,
    };
  }

  if (session.playbookId && session.playbookId !== playbook.id) {
    return {
      status: "refused",
      reason: `This session already follows playbook ${session.playbookId}. Release it first (followPlaybookId: null), then follow the new one — a session is a run of ONE playbook.`,
    };
  }

  // STAGE: named or NULL. Never guessed, never stage 1.
  const validKeys = stageKeysOf(playbook);
  const stageKey = params.followStageKey ?? null;
  if (stageKey !== null && !validKeys.includes(stageKey)) {
    return {
      status: "refused",
      reason:
        validKeys.length > 0
          ? `"${stageKey}" is not a stage of "${playbook.name}". Valid stage keys: ${validKeys
              .map((k) => `"${k}"`)
              .join(
                ", "
              )}. Omit followStageKey to leave the session in no stage.`
          : `"${playbook.name}" declares no stages, so no stage key is valid. Omit followStageKey.`,
    };
  }

  // PARAMS — validated before anything is written, with the one pure
  // validator. A mistyped value is a malformed call and refuses here; an
  // unanswered required one becomes an owed slot below (see
  // `FollowPlaybookParams.params`).
  const paramResolution = validatePlaybookParams(
    readPlaybookParams(playbook.params),
    params.params
  );
  if (paramResolution.typeErrors.length > 0) {
    const [first] = paramResolution.typeErrors;
    return {
      status: "refused",
      reason: first!.options
        ? `"${first!.name}" must be one of ${first!.options.map((o) => `"${o}"`).join(", ")} — got "${first!.received}". Nothing was changed.`
        : `"${first!.name}" must be a ${first!.type} — got "${first!.received}". Nothing was changed.`,
    };
  }

  // GRANT WIDENING — governed, never silent. The playbook's capabilities are
  // read at run time from its `grants` links, so binding this session to it
  // widens what the session may call the moment the row is written.
  const grantEdges = await getLinksFor(userId, "playbook", playbook.id);
  const granted = await resolveGrantedCapabilities(grantEdges, {
    linkType: "grants",
    fromType: "playbook",
  });
  if (granted.length > 0) {
    const { checkPermissionOrPropose } =
      await import("../../utils/permission-check.js");
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId,
      workspaceId: session.workspaceId ?? undefined,
      subjectType: "focus_session",
      action: "grant_capability",
      source: "intelligence",
      data: {
        sessionId,
        followPlaybookId: playbook.id,
        playbookName: playbook.name,
        capabilities: granted.map((g) => ({ kind: g.kind, id: g.id })),
      },
    });
    if ("denied" in perm && perm.denied) {
      return { status: "refused", reason: perm.reason };
    }
    if ("proposalId" in perm) {
      return {
        status: "proposed",
        proposalId: perm.proposalId,
        proposalType: perm.proposalType,
        summary: perm.summary,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
        reason: `Following "${playbook.name}" would widen this session's capabilities by ${granted.length} (${granted
          .map((g) => `${g.kind}:${g.id}`)
          .join(
            ", "
          )}). Nothing was changed — the widening is waiting for review.`,
      };
    }
  }

  const followedAt = new Date().toISOString();
  // Diffed against the LOCKED base inside the transaction, so only slots THIS
  // attach blocked count — a slot already owed stays the block that filed it.
  let blockedByThisAttach: ReturnType<typeof newlyBlockedSlots> = [];
  const { updated, addedCriteria, addedOutputs, runId } = await db.transaction(
    async (tx) => {
      const [locked] = await tx
        .select({
          criteria: focusSessions.criteria,
          expectedOutputs: focusSessions.expectedOutputs,
          metadata: focusSessions.metadata,
        })
        .from(focusSessions)
        .where(eq(focusSessions.id, sessionId))
        .for("update");

      const currentCriteria = readCriteria(locked?.criteria);
      const nextCriteria: SessionCriterion[] = mergeCriteria(
        currentCriteria,
        collectPlaybookCriteria(playbook)
      );

      const currentOutputs: ExpectedOutput[] = Array.isArray(
        locked?.expectedOutputs
      )
        ? (locked.expectedOutputs as ExpectedOutput[])
        : [];
      const paramSlots: ExpectedOutput[] = paramResolution.missingRequired.map(
        (p) => ({
          kind: PARAM_SLOT_KIND,
          label: `Answer: ${p.label?.trim() || p.name}`,
          owner: "human" as const,
          blockedReason: "decision" as const,
          why: `"${playbook.name}" needs a value for "${p.label?.trim() || p.name}"${
            p.options?.length
              ? ` (one of ${p.options.map((o) => `"${o}"`).join(", ")})`
              : ` (${p.type})`
          }. Nobody supplied it when this session began following it.`,
          owedSince: followedAt,
        })
      );
      // Merged by label like the playbook's own slots, so following twice does
      // not file the same question again.
      const added = [
        ...newSlotsFrom(playbook, currentOutputs),
        ...paramSlots.filter(
          (slot) =>
            !currentOutputs.some(
              (o) =>
                normalizeExpectedLabel(o?.label) ===
                normalizeExpectedLabel(slot.label)
            )
        ),
      ];
      // Through the ONE merge, with the stored array echoed verbatim: every
      // receipt on a live slot (a delegation, an `owedSince` clock, an
      // approval's lineage) is carried forward, and the playbook's slots land
      // as the new, pending declarations they are.
      const nextOutputs = mergeExpectedOutputs(currentOutputs, [
        ...currentOutputs,
        ...added,
      ]);
      blockedByThisAttach = newlyBlockedSlots(currentOutputs, nextOutputs);

      const [row] = await tx
        .update(focusSessions)
        .set({
          playbookId: playbook.id,
          criteria: nextCriteria,
          expectedOutputs: nextOutputs,
          // Only when NAMED. Absent leaves the column exactly as it was.
          ...(stageKey !== null ? { currentStage: stageKey } : {}),
          // MERGED in SQL, never assigned over the bag: this row's metadata
          // carries the title provenance, the run prompt and the probe marker.
          metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
            {
              [FOLLOWED_AT_METADATA_KEY]: followedAt,
              [FOLLOWED_VIA_METADATA_KEY]: FOLLOWED_VIA_ATTACH,
              // MERGED over what the row already carried, never replacing it:
              // a session that was started with some answers and later follows
              // the playbook keeps them. Read out of the LOCKED row inside the
              // transaction for the same reason the criteria merge is.
              [RUN_PARAMS_METADATA_KEY]: {
                ...((locked?.metadata as Record<string, unknown> | null)?.[
                  RUN_PARAMS_METADATA_KEY
                ] as Record<string, unknown> | undefined),
                ...paramResolution.declaredValues,
              },
            }
          )}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(focusSessions.id, sessionId))
        .returning();

      // The ledger row, WITH the definition pinned. Same five snapshot fields
      // `create-session.ts` writes — a run executes what it started with.
      const [run] = await tx
        .insert(playbookRuns)
        .values({
          workspaceId: session.workspaceId,
          playbookId: playbook.id,
          sessionId,
          executor: playbook.executor,
          status: "running",
          createdBy: agentUserId ?? userId,
          // THE helper, not a seventh hand-written field list
          // (`run-playbook.ts`). `create-session.ts` still inlines FIVE of its
          // six fields — it omits `criteria` — which is exactly the drift a
          // second copy produces; routing that call site through this helper
          // belongs to whoever next touches it.
          definitionSnapshot: buildDefinitionSnapshot(playbook),
        })
        .returning({ id: playbookRuns.id });

      return {
        updated: row,
        addedCriteria: nextCriteria.length - currentCriteria.length,
        addedOutputs: added.length,
        runId: run?.id ?? null,
      };
    }
  );

  // The safety net every slot-ownership door carries: a playbook slot declared
  // `owner: "human"` lands a blocker on a person, and the guideline that covers
  // it must ride back on the response rather than sitting unread in config.
  const blockGuidelines = await guidanceForBlockedSlots({
    userId,
    workspaceId: session.workspaceId ?? null,
    slots: blockedByThisAttach,
  });

  // Provenance edge — the same `instantiated_from` an instantiate writes, so
  // "every run of this playbook" is one graph query however the run began.
  // Idempotent on the unique edge.
  await createLinks([
    {
      workspaceId: session.workspaceId,
      fromType: "session",
      fromId: sessionId,
      toType: "playbook",
      toId: playbook.id,
      linkType: "instantiated_from",
      metadata: { followedAt, followedVia: FOLLOWED_VIA_ATTACH },
    },
  ]);

  return {
    status: "ok",
    session: updated as FocusSession,
    follow: {
      action: "attached",
      playbookId: playbook.id,
      playbookName: playbook.name,
      stageKey,
      becameRun: true,
      mergedCriteria: addedCriteria,
      mergedOutputs: addedOutputs,
      runId,
      ...(blockGuidelines ? { blockGuidelines } : {}),
      note:
        `This session is now a run of "${playbook.name}" — it appears in that playbook's runs and leaves the work list.` +
        (stageKey === null && validKeys.length > 0
          ? ` It is in no stage yet; name one with followStageKey (${validKeys.map((k) => `"${k}"`).join(", ")}).`
          : ""),
    },
  };
}

/** `followPlaybookId: null` — release the playbook, keep the structure. */
async function releasePlaybook(
  session: FocusSession
): Promise<FollowPlaybookResult> {
  if (!session.playbookId) {
    return {
      status: "refused",
      reason:
        "This session does not follow a playbook, so there is nothing to release.",
    };
  }

  // REFUSED under an open gate. The gate pauses the session and asks a person
  // about a stage of THIS playbook; releasing it mid-question would leave a
  // pending approval whose subject the session no longer has.
  const gate = await pendingStageGate(session);
  if (gate) {
    return {
      status: "refused",
      reason:
        gate === "human"
          ? "A stage gate on this session is waiting for approval — answer it first, then release the playbook. Nothing was changed."
          : "A stage check on this session has not passed yet — resolve it first, then release the playbook. Nothing was changed.",
    };
  }

  const [playbook] = await db
    .select({ name: playbooks.name })
    .from(playbooks)
    .where(eq(playbooks.id, session.playbookId))
    .limit(1);

  const [run] = await db
    .select({ id: playbookRuns.id })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, session.id),
        eq(playbookRuns.status, "running")
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);

  const [updated] = await db
    .update(focusSessions)
    .set({
      playbookId: null,
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
        { [UNFOLLOWED_AT_METADATA_KEY]: new Date().toISOString() }
      )}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(focusSessions.id, session.id))
    .returning();

  if (run) {
    // `cancelled`, not `failed` or `completed`: the run did not fail and it did
    // not finish. A `failed` row would grade the playbook for a person's change
    // of mind, and the scorecard feeds governance widening.
    await db
      .update(playbookRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(playbookRuns.id, run.id));
  }

  const keptCriteria = readCriteria(updated?.criteria).length;
  const keptOutputs = Array.isArray(updated?.expectedOutputs)
    ? (updated.expectedOutputs as ExpectedOutput[]).length
    : 0;

  return {
    status: "ok",
    session: updated as FocusSession,
    follow: {
      action: "detached",
      playbookId: null,
      playbookName: playbook?.name ?? null,
      stageKey: updated?.currentStage ?? null,
      becameRun: false,
      mergedCriteria: keptCriteria,
      mergedOutputs: keptOutputs,
      runId: run?.id ?? null,
      note: `This session is work again, not a run${
        playbook?.name ? ` of "${playbook.name}"` : ""
      }. Its ${keptCriteria} acceptance criteria and ${keptOutputs} deliverables STAY — they are the session's own now; delete any you do not want.`,
    },
  };
}

/** The refusal as a `BAD_REQUEST`, for the doors that speak in throws. */
export function followRefusalError(reason: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message: reason });
}
