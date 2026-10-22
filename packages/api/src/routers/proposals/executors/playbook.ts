import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  playbooks,
  playbookRuns,
  entities,
  eq,
  inArray,
  getWorkspaceMembership,
} from "@synap/database";
// `createLinks` is the ONE link door and it lives in @synap/api, not
// @synap/database — the database package's `ensure-external-channel.ts` says so
// explicitly. Importing it from @synap/database is a compile error, which is how
// this arrived: the symbol name is right, the package was not.
import { createLinks } from "../../../services/links/links-service.js";
import { ProposalStatus } from "@synap/database/schema";
import { isLikelyUUID } from "@synap-core/types/proposals";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import {
  assertApplied,
  dispatchExternalOnce,
  reportApproved,
} from "./shared.js";
import type { PlaybookStageInput } from "../../../schemas/playbook-stage.js";
import { settleParentAutomationRunFromChild } from "@synap/jobs";
import { readBatchSubjectIds } from "@synap/jobs/utils/automation-governance.js";

/** Register the playbook/* approve executors. */
/**
 * Can this approval be applied, or did the proposal lose the arguments the run
 * needs? Pure, and exported so it can be tested — the inline version had no
 * coverage at all, and it decides between starting a run and refusing one.
 *
 * The rule: refuse only when the playbook DECLARES an argument that THIS
 * proposal did not carry. It used to refuse whenever the playbook declared
 * anything, because the gate stored nothing — which made every parameterised
 * playbook un-approvable (14 of the ones installed on this pod).
 */
export function missingRunArgs(input: {
  declaredParamCount: number;
  hasSubjectProfile: boolean;
  carriedParams: Record<string, unknown> | undefined;
  carriedSubjectId: string | undefined;
}): { needsParams: boolean; needsSubject: boolean; refuse: boolean } {
  const needsParams = input.declaredParamCount > 0 && !input.carriedParams;
  const needsSubject = input.hasSubjectProfile && !input.carriedSubjectId;
  return { needsParams, needsSubject, refuse: needsParams || needsSubject };
}

/**
 * Why an approved run did not start — ONE sentence per non-running outcome of
 * `playbooks.run`, shown after "Couldn't apply — ". Each one says what to do.
 */
export function notStartedReason(result: {
  status: "proposed" | "blocked" | "skipped";
  message: string;
}): string {
  if (result.status === "proposed") {
    // The approver's OWN check refused (the agent's policy is not consulted on
    // an approved replay), so this one really is about their role.
    return "your workspace role cannot run this playbook, so approving it only filed another proposal — ask a workspace admin or owner to approve that one";
  }
  // `blocked` (skills not enabled) / `skipped` (cooling down, nothing ready):
  // the door's own sentence, as a clause.
  const clause = result.message.replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(clause)
    ? clause[0]!.toLowerCase() + clause.slice(1)
    : clause;
}

export function registerPlaybookExecutors(): void {
  // ── playbook / create ────────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated playbook RAW create lands here on
  // approval (the promote path emits `playbook/promote` — its own executor
  // below — so this key materializes exactly one shape). Materializes via the
  // SAME playbooksRouter.create the direct path uses — re-run as the APPROVER
  // with NO agentUserId + no source, so the gate auto-grants for the operator.
  // The propose gate widened `data` to the full create input (goalTemplate is
  // required by createInputSchema).
  //
  // targetId: the playbook lands under the id the proposal promised (its
  // targetId, minted by `playbooks.create` before its gate), via
  // `proposedPlaybookId`. Before, the database minted a second id, so the id
  // an agent read off its own proposal named no playbook (live ee96643d,
  // 2026-10-21: targetId 6847b54f, created 48e6878a). A proposal filed before
  // the gate minted the id carries a random targetId that names nothing — it
  // is adopted too, so every approved create keeps its proposal's id.
  registerProposalExecutor({
    key: "playbook/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const goalTemplate = innerData.goalTemplate as string | undefined;
      if (!name || !goalTemplate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook proposal is missing name/goalTemplate",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: createCaller mints a fresh playbook id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      const createArgs = {
        ...(isLikelyUUID(proposal.targetId)
          ? { proposedPlaybookId: proposal.targetId }
          : {}),
        name,
        description: innerData.description as string | undefined,
        goalTemplate,
        params: innerData.params as Record<string, unknown>[] | undefined,
        inputStrategy: innerData.inputStrategy as
          Record<string, unknown> | undefined,
        channelSpec: innerData.channelSpec as
          Record<string, unknown> | undefined,
        expectedOutputs: innerData.expectedOutputs as
          Record<string, unknown>[] | undefined,
        // Re-validated by `playbooks.create` (`playbookStagesSchema`). NOTE: a
        // proposal created BEFORE stage categories existed carries
        // category-less stages and will be rejected on approval — by design;
        // the proposal must be revised to declare categories.
        stages: innerData.stages as PlaybookStageInput[] | undefined,
        // Re-validated by `playbooks.create` (`sessionCriteriaSchema`).
        criteria: innerData.criteria,
        // What the playbook NEEDS the pod to do. Re-validated by
        // `playbooks.create` (`playbookRequiredIntentsSchema`). Read back for
        // the same reason `criteria` is: without it an APPROVED playbook
        // materializes with an empty requirement list — the agent's declaration
        // is silently dropped on the one path a human explicitly approved.
        requiredIntents: innerData.requiredIntents as string[] | undefined,
        subjectProfile: innerData.subjectProfile as
          Record<string, unknown> | undefined,
        schedule: innerData.schedule,
        // Propose-only governance marker (maintenance playbooks) — read back so
        // an AI-proposed playbook keeps `metadata.governance.forceProposeWrites`
        // when a human approves it.
        metadata: innerData.metadata as Record<string, unknown> | undefined,
        executor: innerData.executor,
        status: innerData.status,
        // 0240: a project-scoped BLUEPRINT approved without its scope would
        // materialize as a session template — the one field that decides what
        // the template even is.
        scope: innerData.scope as "session" | "project" | undefined,
        // The propose gate stores the Layer-2 context skill in `data`; without
        // reading it back here an APPROVED playbook materialized with no context
        // skill at all — i.e. the feature was a no-op on the agent-proposed path,
        // which is exactly the path that needs a generated HOW. Note this
        // re-runs with NO agentUserId, so the skill is born approved: the human
        // approval genuinely covers it, and the executor will inject it.
        contextSkill: innerData.contextSkill as
          { name?: string; body: string } | undefined,
      };
      // The replay must APPLY, never re-propose — see `assertApplied`.
      const created = await playbookCaller.create(
        createArgs as Parameters<typeof playbookCaller.create>[0]
      );
      assertApplied(created);

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      // The id the playbook actually landed under — the proposal's own id, or
      // the same-name playbook a concurrent create won with.
      return {
        success: true,
        ...(created.playbook?.id ? { primaryId: created.playbook.id } : {}),
      };
    },
  });

  // ── playbook / update ────────────────────────────────────────────────────────
  // An agent editing a playbook — retuning a goal template, reordering stages,
  // or setting `scope: 'project'` — files a proposal. Until this executor
  // existed, approving one hit the `*/*` catch-all and threw NOT_IMPLEMENTED:
  // the reviewer said yes and NOTHING happened. Same defect class as
  // project/update; the write door and its approval half ship together.
  //
  // Replays through the SAME playbooksRouter.update the direct path uses, as
  // the APPROVER (no agentUserId ⇒ the re-entrant gate auto-grants), so the
  // definition-version bump, cron re-materialization and events are identical
  // to a direct update.
  registerProposalExecutor({
    key: "playbook/update",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const playbookId =
        (innerData.id as string | undefined) ?? proposal.targetId;
      if (!playbookId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook update proposal is missing the playbook id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // `playbooksRouter.update` loads the row by id and gates on the LOADED
      // row's workspace, so the caller ctx needs only a workspace the approver
      // belongs to — take it from the PROPOSAL, and verify membership.
      const workspaceId = proposal.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook update proposal is missing a valid workspaceId",
        });
      }
      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);

      // Only the keys the proposal actually carries are replayed — an absent
      // key must stay absent so `update` leaves that field untouched.
      const REPLAYED = [
        "name",
        "description",
        "goalTemplate",
        "params",
        "inputStrategy",
        "channelSpec",
        "expectedOutputs",
        "stages",
        "criteria",
        "requiredIntents",
        "subjectProfile",
        // The process declarations. The update door FOLDS them into
        // `subjectProfile` before its gate, so a proposal carries them there;
        // replayed by name too, so a payload that states them is never dropped.
        "activators",
        "humanOnlyStatuses",
        "schedule",
        "executor",
        "status",
        "scope",
        "metadata",
      ] as const;
      const patch: Record<string, unknown> = { id: playbookId };
      for (const key of REPLAYED) {
        if (key in innerData) patch[key] = innerData[key];
      }

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await playbookCaller.update(
          patch as Parameters<typeof playbookCaller.update>[0]
        )
      );

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── playbook / promote ───────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated session→playbook PROMOTE lands here on
  // approval (the promote gate emits `playbook/promote`, distinct from raw
  // create). Materializes via the SAME playbooksRouter.promote the direct path
  // uses — re-run as the APPROVER with NO agentUserId + no source; promote is a
  // protectedProcedure that loads the session by id and gates on the LOADED
  // session's workspace, so the caller ctx needs only userId. The stored `data`
  // carries { sessionId, name, description } — the rest is snapshotted FROM the
  // session by promoteSessionToPlaybook, so no further widening is needed.
  //
  // targetId NOTE (decision B): promoteSessionToPlaybook mints the playbook id —
  // adoption is a follow-up.
  registerProposalExecutor({
    key: "playbook/promote",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const sessionId = innerData.sessionId as string | undefined;
      if (!sessionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook promote proposal is missing sessionId",
        });
      }

      // Idempotency: promoteSessionToPlaybook mints a fresh playbook id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
      } as unknown as Context);
      const promoteArgs = {
        sessionId,
        name: innerData.name as string | undefined,
        description: innerData.description as string | undefined,
      };
      await playbookCaller.promote(
        promoteArgs as Parameters<typeof playbookCaller.promote>[0]
      );

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── playbook/archive ──────────────────────────────────────────────────────
  // The gate at `routers/playbooks.ts:1727` has existed with NO executor, so an
  // approved archive fell to the `*/*` catch-all — which for a gate-made
  // proposal does not throw: it emits `.validated`, flips the status to
  // APPROVED and returns success. The reviewer saw green and the playbook was
  // never archived. `archive` is on the rung-2.5 DESTRUCTIVE floor, which no
  // rung can widen, so an agent archiving a playbook ALWAYS proposes — this
  // path is reachable by construction, not by accident.
  //
  // ⚠️ Archiving is TWO writes, not one: `playbooks.status = 'archived'` AND
  // `materializePlaybookCronAutomation`, which tears down the backing cron.
  // Setting the status alone would leave a live automation firing a playbook
  // nothing surfaces (the S1 note at the direct call site says so explicitly).
  // So this replays through `playbooksRouter.archive` rather than writing the
  // column — ONE door, both effects, and it cannot drift from the direct path.
  //
  // Re-running the gated procedure does NOT re-propose: the caller ctx carries
  // no `agentUserId`, so `checkPermissionOrPropose` takes the human path and
  // executes inline. Same technique as `playbook/update` above.
  //
  // The stored payload is FLAT (`data: { id, name }` at the gate) — unlike
  // `playbook/update`, which nests under `data.data`. Read both shapes so a
  // proposal filed by either convention still applies.
  registerProposalExecutor({
    key: "playbook/archive",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const playbookId =
        (raw.id as string | undefined) ??
        (inner.id as string | undefined) ??
        proposal.targetId;
      if (!playbookId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook archive proposal is missing the playbook id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const workspaceId = proposal.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook archive proposal is missing a valid workspaceId",
        });
      }
      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);

      // `archive` is idempotent on its own ("Playbook already archived").
      await playbookCaller.archive({ id: playbookId });

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
  // ── playbook / run ────────────────────────────────────────────────────────
  // THE ONE IN THIS FILE THAT IS BROKEN IN NORMAL USE, not merely latent.
  //
  // `playbooks.run` (routers/playbooks.ts:2011) says it outright in its own
  // docstring: on `"proposed"` **no run is created — the proposal IS the
  // record — and only on approval does `runPlaybook` execute**. There was no
  // `playbook/run` executor, so approval hit the `*/*` catch-all, which for a
  // gate-made proposal does NOT throw: it emits `.validated`, flips the row
  // APPROVED and returns success. So the user approved a playbook run, saw
  // green, and the playbook never ran. EVERY agent-initiated run — the MCP
  // `synap_run_playbook` door (mcp/handlers/build.ts) always passes an
  // `agentUserId`, so it always proposes — has been in that state.
  //
  // PAYLOAD: the gate stores FLAT `data: { playbookId, name }` — note the key
  // is `playbookId`, NOT `id` like every other door in this file, and
  // `proposal.targetId` is derived from `data.id` which is ABSENT here, so
  // targetId is a RANDOM uuid, not the playbook. Reading `targetId` as the
  // playbook id would run the wrong thing (or nothing). Both the flat and the
  // `data.data` nesting are read; `targetId` deliberately is NOT.
  //
  // ⚠️ RUN ARGUMENTS, AND WHY THIS EXECUTOR STILL REFUSES SOME RUNS.
  // `playbooks.run` accepts `params`, `subjectId`, `agentIds` and `agentUserId`
  // and forwards all four to `runPlaybook`. The gate NOW STORES the first three
  // (`routers/playbooks.ts`, the `checkPermissionOrPropose` `data`), and this
  // executor replays them. It previously stored none, which mattered because:
  //   - `params` feeds `resolveInputItems` AND the goalTemplate substitution in
  //     `instantiateSession` — a run with `{}` gets a different GOAL.
  //   - `subjectId` becomes `focus_sessions.subjectEntityId` — dropping it is
  //     the difference between "onboard Acme Corp" and "onboard nobody".
  //   - `agentIds` are the extra agents added to the run channel.
  // Starting a session + channel + executor dispatch under the wrong goal or no
  // subject is WORSE than the silent no-op it replaces, so this executor still
  // does not guess. What changed is the TEST: it used to refuse whenever the
  // PLAYBOOK declared arguments (which refused every parameterised playbook,
  // i.e. the governed path could not run 14 of the ones installed on this pod);
  // it now refuses only when THIS PROPOSAL did not carry what the playbook
  // needs. Proposals filed BEFORE the gate was widened carry nothing, so they
  // are still refused, with the same reason and a re-run instruction.
  // OWNERSHIP of an approved run: the PERSON who approved it. An agent-started
  // session is a triage draft until the person accepts it (`draft-asks.ts`,
  // `triage.ts`); approving the run IS that acceptance. So the agent that asked
  // (`proposal.agentUserId`) rides on the session's ROSTER (`agentIds` — the
  // starter, read by `attachSessionParticipants`), and the session, channel
  // and run are owned by the human principal. It used to be threaded back as
  // `agentUserId`, which made `runPlaybook`'s `actorId` the AGENT: session
  // reads are owner-only (`sessionReadableWhere`) and an agent key reads as its
  // human, so the approved session was invisible to the person AND to the
  // agent (live 2026-10-20: proposal fcdc4804 → `sessionPrivate: true`).
  //
  // ⚠️ IDEMPOTENCY — verified, and the standard guard is NOT sufficient.
  // `runPlaybook` is NOT idempotent on this path: its `idempotentBySubject`
  // reuse is OPT-IN and `playbooks.run` never sets it ("manual runs leave this
  // false so each click starts fresh"). Two approvals would mint two sessions,
  // two channels, two ledger rows and two executor dispatches. The sibling
  // `status === APPROVED` guard is a read-then-write and races a double-click,
  // so it is kept only as the cheap short-circuit; the real floor is
  // `dispatchExternalOnce`, this directory's CAS-claim primitive for an
  // irreversible side effect — it claims `external_dispatched_at` atomically,
  // and on a THROWN failure deliberately KEEPS the claim (at-most-once: never
  // risk a second dispatch on retry) so the proposal lands APPROVAL_FAILED
  // rather than falsely APPROVED.
  //
  // Replayed through `playbooksRouter.run` — never `runPlaybook` directly — so
  // the visibility load, the editor+ `assertWorkspaceWrite` floor and the
  // subject IDOR guard all run again. Re-running the gated procedure does not
  // re-propose on the AGENT's policy: the caller ctx carries
  // `governanceProposalId`, so `playbooks.run` gates on the approver (the human
  // path); the agent that asked rides on the roster (see OWNERSHIP). (Until
  // 2026-10-12 this said the ctx's missing `agentUserId` did that — but the
  // INPUT `agentUserId` reached the gate, so every agent-filed run whose policy
  // is "propose" re-proposed on approval and could never be applied.)
  registerProposalExecutor({
    key: "playbook/run",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      // `playbookId`, not `id` — and NOT `proposal.targetId`, which for this
      // gate is a random uuid (see the payload note above).
      let playbookId =
        (inner.playbookId as string | undefined) ??
        (raw.playbookId as string | undefined);
      // A PROPOSE-MODE RULE whose node names its playbook by NAME only
      // (template-friendly nodes do) files `playbookName` and no id. Resolved
      // HERE, at approval, through the ONE runnable-playbook door
      // (`resolveRunnablePlaybook`: this workspace, then pod-wide, with the
      // cross-workspace guard) — never a second name lookup in the worker.
      const playbookName =
        typeof inner.playbookName === "string" ? inner.playbookName : undefined;
      if (!playbookId && playbookName && proposal.workspaceId) {
        const { resolveRunnablePlaybook } =
          await import("../../../services/playbooks/playbook-lifecycle.js");
        playbookId = (
          await resolveRunnablePlaybook({
            playbookName,
            workspaceId: proposal.workspaceId,
          })
        ).id;
      }
      if (!playbookId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook run proposal is missing playbookId",
        });
      }

      // Cheap short-circuit only — the at-most-once floor is the CAS claim below.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // `playbooks.run` is a workspaceProcedure — the run's workspace is the one
      // the proposal was filed under and reviewed in.
      const workspaceId = proposal.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook run proposal is missing a valid workspaceId",
        });
      }
      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      // Re-read the playbook AT APPROVAL TIME and refuse the runs whose
      // arguments the gate discarded (see the ⚠️ note above).
      const playbook = await db.query.playbooks.findFirst({
        where: eq(playbooks.id, playbookId),
        columns: { id: true, name: true, params: true, subjectProfile: true },
      });
      if (!playbook) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Playbook to run no longer exists",
        });
      }
      const declaredParams = Array.isArray(playbook.params)
        ? playbook.params
        : [];
      // The gate NOW stores `params`/`subjectId`/`agentIds`, so the question is
      // no longer "does this playbook take arguments" (it refused every
      // parameterised playbook on that test) but "did THIS proposal carry the
      // ones it needs". A proposal filed before the gate was widened still
      // carries none, and is still refused — correctly, and with the same
      // reason — rather than replaying under a goal with `{}` substituted in.
      const carriedParams =
        inner.params && typeof inner.params === "object"
          ? (inner.params as Record<string, unknown>)
          : undefined;
      const carriedSubjectId =
        typeof inner.subjectId === "string" ? inner.subjectId : undefined;
      const { needsParams, needsSubject, refuse } = missingRunArgs({
        declaredParamCount: declaredParams.length,
        hasSubjectProfile: playbook.subjectProfile != null,
        carriedParams,
        carriedSubjectId,
      });
      if (refuse) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `Cannot apply this approval: "${playbook.name}" takes run arguments ` +
            `(${needsParams ? "params" : ""}` +
            `${needsParams && needsSubject ? " and " : ""}` +
            `${needsSubject ? "a subject entity" : ""}), ` +
            "but this proposal did not carry them, so approving would start a " +
            "run with the wrong goal or no subject. Run it directly instead. " +
            "(Proposals filed before the gate stored run arguments cannot be " +
            "applied — re-run the playbook to file a new one.)",
        });
      }

      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
        // "A decision exists for this write": `playbooks.run` then checks the
        // APPROVER. Without it, a proposal filed by an agent whose policy is
        // "propose" re-proposed on every approval.
        governanceProposalId: proposal.id,
      } as unknown as Context);

      // ONE run per subject. A BATCH proposal (one import's leads, coalesced
      // by `proposeRulePlaybookRun`) lists `subjectIds`; a single one carries
      // `subjectId`. Same door, same arguments, for each.
      const subjects = readBatchSubjectIds(inner);
      const rosterAgentIds = [
        ...new Set(
          [
            proposal.agentUserId,
            ...(Array.isArray(inner.agentIds) ? inner.agentIds : []),
          ].filter((id): id is string => typeof id === "string" && id !== "")
        ),
      ];
      const runFor = (subjectId: string | undefined) =>
        playbookCaller.run({
          playbookId,
          // EXPLICIT write lens — `proposal.workspaceId` is the workspace the
          // gate ran against when this run was proposed, so the replay must
          // land there. Passed explicitly (not left to the ambient ctx rung of
          // `resolvePlaybookRunWriteWorkspace`) so the approved run is filed in
          // exactly the workspace that was reviewed.
          workspaceId,
          // The run arguments the caller actually asked with, replayed from the
          // proposal. Guarded above: whatever this playbook declares and this
          // proposal did not carry has already been refused, so a run reaching
          // here is the one the caller described, not a guess at it.
          ...(carriedParams ? { params: carriedParams } : {}),
          ...(subjectId ? { subjectId } : {}),
          // The roster: the agent that asked (the starter) + any extra agents
          // the run was proposed with. See OWNERSHIP above.
          ...(rosterAgentIds.length > 0 ? { agentIds: rosterAgentIds } : {}),
          // Lineage: the session the run was proposed FROM. Replayed so an
          // approved run lands on the map spawned from the work that asked for
          // it, exactly as a direct run does.
          ...(typeof inner.parentSessionId === "string"
            ? { parentSessionId: inner.parentSessionId }
            : {}),
          // Filing: the project/track the run was proposed INTO. Re-validated
          // by the replay (`resolveTrackFiling` inside `runPlaybook`), so a
          // track archived since the proposal refuses rather than files.
          ...(typeof inner.projectId === "string"
            ? { projectId: inner.projectId }
            : {}),
          ...(typeof inner.trackId === "string"
            ? { trackId: inner.trackId }
            : {}),
          ...(typeof inner.trackId === "string" &&
          typeof inner.trackStage === "string"
            ? { trackStage: inner.trackStage }
            : {}),
          // The goal + agent the run was asked WITH (a propose-mode rule's
          // `goalOverride` / `agentType`, or a gated `playbooks.run` that named
          // them). Without these an approved rule run silently fell back to
          // the playbook's goal and the default agent.
          ...(typeof inner.goalOverride === "string" &&
          inner.goalOverride.trim() !== ""
            ? { goalOverride: inner.goalOverride }
            : {}),
          ...(typeof inner.agentType === "string" &&
          inner.agentType.trim() !== ""
            ? { agentType: inner.agentType }
            : {}),
        });
      let batch: BatchRunReceipt | undefined;
      // What this approval started — EVERY approval, not only a batch: the
      // session is the door the person opens next, and a single run used to
      // drop it (the receipt named nothing it had created).
      let receipt: BatchRunReceipt | undefined;

      // At-most-once: `runPlaybook` is NOT idempotent here (verified — see the
      // note above), so the dispatch is CAS-claimed. A thrown failure keeps the
      // claim and lands APPROVAL_FAILED rather than a false APPROVED.
      await dispatchExternalOnce(input.proposalId, async () => {
        // The FIRST run proves the approver may run it; a re-propose there
        // means nothing was started, so the claim is released (see below).
        const firstSubject = subjects[0] ?? carriedSubjectId;
        const result = await runFor(firstSubject);
        if (result.status === "running" && subjects.length > 1) {
          batch = await runBatchRest(
            subjects.slice(1),
            runFor,
            startedRun(subjects[0]!, result)
          );
        }
        if (result.status === "running") {
          receipt = batch ?? {
            started: [startedRun(firstSubject, result)],
            failed: [],
          };
          return { delivered: true as const };
        }
        // Nothing started, so the claim is released and the person can approve
        // again once the reason is fixed.
        return { delivered: false as const, reason: notStartedReason(result) };
      });

      // A run that starts now supersedes an earlier failed attempt: the
      // approval's own failure record (`rejectionReason`, `data.failure`,
      // written by `onApprovalFailed`) would otherwise sit on an APPROVED
      // row and read "Couldn't apply" beside the session it did create.
      const { failure: _staleFailure, ...rawWithoutFailure } = raw;
      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          rejectionReason: null,
          // Every run the approval started is recorded ON the proposal — the
          // outcome renderers already read (`data.runResult`) — so the person
          // can open each session. Not `materialized`: approving a run does
          // not opt its session into undo.
          data: receipt
            ? { ...rawWithoutFailure, runResult: receipt }
            : rawWithoutFailure,
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      const firstSessionId = receipt?.started[0]?.sessionId;
      return {
        success: true,
        // The approve response's "what this created" (REST/CLI callers).
        ...(firstSessionId ? { primaryId: firstSessionId } : {}),
        ...(batch
          ? { batch: { started: batch.started.length, failed: batch.failed } }
          : {}),
      };
    },
  });

  // ── playbook_run / update ─────────────────────────────────────────────────
  // Before the payload widening this gate stored `{ runId }`, so an approved
  // capture-back had no status, no summary, no error and no provenance to
  // apply. It now carries `{ runId, status, summary, error, producedEntityIds }`.
  //
  // NO PROCEDURE TO REPLAY: the direct path is inline in the REST handler
  // (`hub-protocol/rest/runs.ts` PATCH), not a tRPC mutation — so this mirrors
  // it, including the two details a naive `.set()` would lose:
  //   1. TERMINAL STAMP — `completed`/`failed`/`proposed` stamp `completedAt`.
  //      Omitting it leaves a finished run with a null completion time.
  //   2. `?? run.<field>` COALESCING — an omitted field keeps its CURRENT value
  //      rather than being blanked. Reading the row first is what makes that
  //      possible; a blind `.set()` from the payload would null out `summary`
  //      on any proposal that only changed `status`.
  //
  // PROVENANCE VALIDATION IS PART OF THE WRITE, not a nicety: each produced id
  // must resolve to an entity in the RUN'S OWN workspace before it is linked.
  // Skipping that would let an approved capture-back fabricate provenance edges
  // to arbitrary, possibly cross-tenant, entity ids. The 100 cap is the direct
  // path's own bound and is reproduced exactly.
  //
  // ⚠️ KNOWN PAYLOAD GAP — `usedCapabilities` IS NOT CARRIED BY THIS GATE.
  // The direct path also writes `session → used → {tool|skill|command}` links
  // from `body.usedCapabilities`, but the gate's `data: { … }` block stores only
  // the five fields above. An approved run therefore records WHAT IT PRODUCED
  // but not WHAT IT USED. That is a gate-payload gap, not an executor gap — it
  // cannot be fixed here, because the information never reached the proposal.
  // Fixing it means widening the gate in `rest/runs.ts` and adding
  // `usedCapabilities` to the `playbook_run/update` pin in
  // `gate-payload-sufficiency.test.ts`. Left deliberately un-faked: inventing
  // an empty array here would look like coverage while writing nothing.
  registerProposalExecutor({
    key: "playbook_run/update",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;
      // The gate stores the id under `runId`, NOT `id` — reading `inner.id`
      // here would find nothing and fall through to `proposal.targetId`.
      const runId =
        (inner.runId as string | undefined) ??
        (raw.runId as string | undefined) ??
        proposal.targetId;
      if (!runId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook run update proposal is missing the run id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const run = await db.query.playbookRuns.findFirst({
        where: eq(playbookRuns.id, runId),
        columns: {
          id: true,
          status: true,
          summary: true,
          error: true,
          completedAt: true,
          sessionId: true,
          workspaceId: true,
        },
      });
      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Playbook run to update no longer exists",
        });
      }

      const nextStatus =
        (inner.status as typeof run.status | undefined) ?? run.status;
      const terminal =
        nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "proposed";

      await db
        .update(playbookRuns)
        .set({
          status: nextStatus,
          summary: (inner.summary as string | undefined) ?? run.summary,
          error: (inner.error as string | undefined) ?? run.error,
          completedAt: terminal ? new Date() : run.completedAt,
        })
        .where(eq(playbookRuns.id, runId));
      // A failed child of an automation run settles its parent (never throws).
      if (terminal)
        await settleParentAutomationRunFromChild({ playbookRunId: runId });

      // `session → produced → entity` provenance, workspace-validated and
      // capped exactly as the direct path does.
      const producedEntityIds = inner.producedEntityIds as string[] | undefined;
      if (run.sessionId && run.workspaceId && producedEntityIds?.length) {
        const requested = producedEntityIds.slice(0, 100);
        const found = await db.query.entities.findMany({
          where: inArray(entities.id, requested),
          columns: { id: true, workspaceId: true },
        });
        const validIds = found
          .filter((e) => e.workspaceId === run.workspaceId)
          .map((e) => e.id);
        if (validIds.length) {
          await createLinks(
            validIds.map((entityId) => ({
              workspaceId: run.workspaceId as string,
              fromType: "session" as const,
              fromId: run.sessionId as string,
              toType: "entity" as const,
              toId: entityId,
              linkType: "produced" as const,
            }))
          );
        }
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}

/** At most this many runs of one batch start at once — sane for 100+ leads. */
export const BATCH_RUN_CONCURRENCY = 3;

/** One run an approval started: its subject (absent = subjectless) and the session to open. */
export interface StartedRun {
  subjectId?: string;
  sessionId?: string;
  runId?: string;
}

/** What a run approval started — stamped on the proposal as `data.runResult`. */
export interface BatchRunReceipt {
  started: StartedRun[];
  failed: string[];
}

function startedRun(
  subjectId: string | undefined,
  result: unknown
): StartedRun {
  const r = result as {
    session?: { id?: unknown };
    run?: { id?: unknown };
  };
  return {
    ...(subjectId ? { subjectId } : {}),
    ...(typeof r.session?.id === "string" ? { sessionId: r.session.id } : {}),
    ...(typeof r.run?.id === "string" ? { runId: r.run.id } : {}),
  };
}

/**
 * Start the rest of a batch's runs, {@link BATCH_RUN_CONCURRENCY} at a time.
 * A subject whose run fails (deleted since, no longer visible) is reported,
 * never allowed to stop its siblings: the approval stands for every subject
 * that can still run. Every started run is returned with its session.
 */
export async function runBatchRest(
  subjects: string[],
  runFor: (subjectId: string) => Promise<{ status: string }>,
  first: StartedRun
): Promise<BatchRunReceipt> {
  const started: StartedRun[] = [first];
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < subjects.length) {
      const subjectId = subjects[next++]!;
      try {
        const r = await runFor(subjectId);
        if (r.status === "running") started.push(startedRun(subjectId, r));
        else failed.push(subjectId);
      } catch {
        failed.push(subjectId);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BATCH_RUN_CONCURRENCY, subjects.length) },
      worker
    )
  );
  return { started, failed };
}
