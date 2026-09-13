/**
 * MCP tool handlers — session domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { db, focusSessions, eq, and, desc, inArray } from "@synap/database";
import { proposedMessageFor } from "../../../utils/permission-check.js";
import {
  withParentSessionId,
  attachParentSessionIds,
} from "../../../services/focus-sessions/parent-lineage.js";
import { attachTriage } from "../../../services/focus-sessions/triage.js";
import type { TerminalSessionStatus } from "../../../services/focus-sessions/session-statuses.js";
import type { ExpectedOutput } from "@synap/playbooks";
import type { UpdateFocusSessionParams } from "../../../services/focus-sessions/update-session.js";
import { SESSION_TITLE_MAX } from "@synap-core/types/focus-sessions";
import {
  SESSION_KINDS,
  attachSessionKind,
  sessionKindWhere,
  sessionAutomationWhere,
} from "../../../services/focus-sessions/session-kind.js";
import {
  ok,
  requireScope,
  resolveAmbientSession,
  OPEN_SESSION_STATUSES,
  SESSION_STATUSES,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One line, not a transcript — mirrors the tool schema's `maxLength`. */
const SUSPENDED_INTENT_MAX = 400;

/**
 * PARSE the slot shapes at the MCP door, with the SAME schemas every other door
 * applies — never a cast.
 *
 * `expectedOutputs` and `addOutput` used to arrive here as `as ExpectedOutput[]`
 * / `as UpdateFocusSessionParams["addOutput"]`. A TypeScript cast asserts a
 * shape; it does not check one, and MCP arguments come off the wire from a
 * language model. So `outputRefWireSchema` — strict, both arms, `isHttpUrl`-
 * gated — ran on the tRPC and Hub REST doors and on NOTHING that arrived here:
 * a seventh `ref.kind` outside `OUTPUT_REF_KINDS` was stored verbatim, and the
 * union three other packages mirror was broken by the door that never looked.
 *
 * WHAT IS PARSED, exactly: the whole `expectedOutputs` array through
 * `expectedOutputWireSchema` (the ONE wire shape, which carries
 * `outputRefWireSchema` on `ref`), and `addOutput.ref` through
 * `outputRefWireSchema`. `addOutput`'s other fields keep their cast — they are
 * cast at every door, this one included, and inventing a second `addOutput`
 * shape here is the per-door drift the shared schema exists to prevent.
 *
 * Returns the zod message as MCP ERROR TEXT rather than throwing: an MCP tool's
 * refusal is a result the model reads and can act on, and a message naming the
 * offending path is what lets it fix the call rather than retry it.
 */
function parseSlotInputs(
  args: Record<string, unknown>,
  schemas: {
    expectedOutputWireSchema: { parse: (v: unknown) => ExpectedOutput };
    outputRefWireSchema: { parse: (v: unknown) => unknown };
  }
):
  | { error: string }
  | {
      expectedOutputs?: ExpectedOutput[];
      addOutput?: UpdateFocusSessionParams["addOutput"];
    } {
  const out: {
    expectedOutputs?: ExpectedOutput[];
    addOutput?: UpdateFocusSessionParams["addOutput"];
  } = {};
  try {
    if (args.expectedOutputs !== undefined) {
      if (!Array.isArray(args.expectedOutputs)) {
        return { error: "expectedOutputs must be an array of declared slots." };
      }
      out.expectedOutputs = args.expectedOutputs.map((item) =>
        schemas.expectedOutputWireSchema.parse(item)
      );
    }
    if (args.addOutput !== undefined) {
      const add = args.addOutput as UpdateFocusSessionParams["addOutput"];
      if (add && add.ref !== undefined && add.ref !== null) {
        schemas.outputRefWireSchema.parse(add.ref);
      }
      out.addOutput = add;
    }
  } catch (err) {
    return {
      error: `Invalid output slot: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return out;
}

export const sessionHandlers: McpHandlerMap = {
  synap_start_session: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // MCP tool schemas are ADVISORY — nothing validates the args server-side,
    // so a non-uuid handle would reach `eq(focusSessions.id, …)` against a
    // `uuid` column. Tell the agent what it may pass instead of letting the
    // shape become a database error. (Hub REST validates the same field with
    // `z.string().uuid()` — this is the MCP door catching up.)
    const parentSessionIdArg = args.parentSessionId;
    if (
      parentSessionIdArg !== undefined &&
      parentSessionIdArg !== null &&
      (typeof parentSessionIdArg !== "string" ||
        !UUID_RE.test(parentSessionIdArg))
    ) {
      return ok({
        error:
          "parentSessionId must be a session UUID (the id of a session you own that you are pushing FROM).",
      });
    }
    // Same advisory-schema reason: a title is ONE line, and the blockers are
    // session handles — refused here in words, not as a varchar or uuid error.
    if (
      args.title !== undefined &&
      args.title !== null &&
      (typeof args.title !== "string" || args.title.length > SESSION_TITLE_MAX)
    ) {
      return ok({
        error: `title must be a string of at most ${SESSION_TITLE_MAX} characters — ONE line naming the session; put the outcome in goal.`,
      });
    }
    const blockedByArg = args.blockedBySessionIds;
    if (
      blockedByArg !== undefined &&
      blockedByArg !== null &&
      (!Array.isArray(blockedByArg) ||
        blockedByArg.length > 20 ||
        !blockedByArg.every((id) => typeof id === "string" && UUID_RE.test(id)))
    ) {
      return ok({
        error:
          "blockedBySessionIds must be an array of at most 20 session UUIDs — sessions you own that this one waits on.",
      });
    }
    const suspendedIntentArg = args.suspendedIntent;
    if (
      suspendedIntentArg !== undefined &&
      suspendedIntentArg !== null &&
      (typeof suspendedIntentArg !== "string" ||
        suspendedIntentArg.length > SUSPENDED_INTENT_MAX)
    ) {
      return ok({
        error: `suspendedIntent must be a string of at most ${SUSPENDED_INTENT_MAX} characters — ONE line naming what you were about to do.`,
      });
    }
    const { createFocusSession } =
      await import("../../../services/focus-sessions/create-session.js");
    const { expectedOutputWireSchema, outputRefWireSchema } =
      await import("../../../services/focus-sessions/update-session.js");
    const slots = parseSlotInputs(args, {
      expectedOutputWireSchema,
      outputRefWireSchema,
    });
    if ("error" in slots) return ok(slots);
    const result = await createFocusSession({
      userId,
      workspaceId: args.workspaceId as string | undefined,
      projectId: args.projectId as string | undefined,
      subjectEntityId: args.subjectEntityId as string | undefined,
      title: typeof args.title === "string" ? args.title : null,
      goal: args.goal as string,
      agentUserId,
      correlationId: args.correlationId as string | undefined,
      channelId: args.channelId as string | undefined,
      agentIds: args.agentIds as string[] | undefined,
      templateId: args.templateId as string | undefined,
      // PARSED by the SHARED wire schema (see `parseSlotInputs`), never a
      // re-typed inline shape: an inline copy silently narrows what this door
      // believes a slot is, which is how the per-door shapes drifted in the
      // first place — and a cast narrows nothing while checking nothing.
      expectedOutputs: slots.expectedOutputs,
      parentSessionId: args.parentSessionId as string | undefined,
      suspendedIntent: args.suspendedIntent as string | undefined,
      // Validated above (array of UUIDs), so this narrows nothing unchecked.
      blockedBySessionIds: Array.isArray(blockedByArg)
        ? (blockedByArg as string[])
        : [],
    });
    return ok(result);
  },
  synap_complete_session: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const { completeFocusSession } =
      await import("../../../services/focus-sessions/complete-session.js");
    const result = await completeFocusSession({
      sessionId: args.sessionId as string,
      userId,
      agentUserId,
      summary: args.summary as string | undefined,
      verificationReport: args.verificationReport as
        Record<string, unknown> | undefined,
      // Every lifecycle exit, not just `closed`. The service has accepted this
      // since it was written; this door never forwarded it, so an agent could
      // record "I finished" but never "I abandoned" or "I could not" — and the
      // tRPC / Hub PATCH doors could. Validated by the tool schema's enum,
      // which derives from TERMINAL_SESSION_STATUSES.
      terminalStatus: args.terminalStatus as TerminalSessionStatus | undefined,
    });
    if (!result) {
      return ok({ error: `Focus session ${args.sessionId} not found` });
    }
    // Gate 2: proposal pack on complete — one review unit for the session.
    return ok({
      // The status the ROW now holds — not a hardcoded "closed". With
      // terminalStatus reachable, a literal here would report every cancel and
      // every failure as a successful close.
      status: result.session.status,
      session: result.session,
      pendingProposals: result.pendingProposals,
      counts: result.counts,
      warnings: result.warnings,
      // `cancelled` only: what the cancel stopped, what was already running and
      // will finish, and what had already applied (undo it with a session
      // revert). Also kept on the session's `metadata.run.cancel`.
      ...(result.cancel ? { cancel: result.cancel } : {}),
      note:
        result.counts.pending > 0
          ? `Review pack: ${result.counts.pending} pending proposal(s) for this session — use synap_list_proposals with sessionId, or open the session room.`
          : // The status the row HOLDS, not "closed". Cancelling a session and
            // being told it "closed" is the same hardcoded-literal slip the
            // response `status` above already had — caught live: a cancel
            // returned `status:"cancelled"` while this line still said closed.
            `Session ${result.session.status} with no pending proposals in the pack.`,
    });
  },
  /**
   * Revert is a HUMAN decision — it takes back approved work — so this door
   * reverts nothing, for any caller. It answers `refused` with the session's
   * revertable proposals and a link to each, so the agent can hand the user the
   * door that does it (session room / proposal). Agent-PROPOSED revert through a
   * governed executor is a follow-up, not this tool.
   */
  synap_revert_session: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    if (!UUID_RE.test(sessionId)) {
      return ok({ error: "sessionId must be a focus session UUID." });
    }
    const [session] = await db
      .select({ id: focusSessions.id, goal: focusSessions.goal })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .limit(1);
    if (!session) {
      return ok({ error: `Focus session ${sessionId} not found` });
    }
    const asked = [
      ...(Array.isArray(args.proposalIds) ? args.proposalIds : []),
      ...(args.proposalId !== undefined ? [args.proposalId] : []),
    ].filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
    const { proposals } = await import("@synap/database");
    const { ProposalStatus } = await import("@synap/database/schema");
    const { openLink } = await import("../../../utils/deep-links.js");
    const revertable = await db
      .select({ id: proposals.id, proposalType: proposals.proposalType })
      .from(proposals)
      .where(
        and(
          eq(proposals.sessionId, sessionId),
          inArray(proposals.status, [
            ProposalStatus.APPROVED,
            ProposalStatus.AUTO_APPROVED,
          ]),
          ...(asked.length > 0 ? [inArray(proposals.id, asked)] : [])
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(50);
    return ok({
      status: "refused",
      reason: "revert_is_a_human_decision",
      message:
        "Reverting takes back work that was already approved, so it is the user's decision — nothing was changed. Give the user the links below: from the session room or a proposal they can undo everything, only some proposals, or one item (items edited since are skipped with the reason).",
      sessionId,
      goal: session.goal,
      ...(typeof args.opKey === "string" ? { opKey: args.opKey } : {}),
      revertable: revertable.map((p) => ({
        proposalId: p.id,
        proposalType: p.proposalType,
        link: openLink(p.id),
      })),
    });
  },
  /**
   * RERUN a session as a NEW session spawned from it (same service as tRPC /
   * Hub). `dryRun` only needs read scope. An agent may rerun in `add` mode —
   * every write still lands through the governed capture/import doors, so a
   * `proposed` outcome is the normal answer — but `replace` reverts approved
   * work and is refused by the service as a human decision.
   */
  synap_rerun_session: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    const dryRun = args.dryRun === true;
    requireScope(apiKeyScopes, dryRun ? "mcp.read" : "mcp.write", toolName);
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    if (!UUID_RE.test(sessionId)) {
      return ok({ error: "sessionId must be a focus session UUID." });
    }
    if (args.mode !== "replace" && args.mode !== "add") {
      return ok({ error: "mode must be 'replace' or 'add'." });
    }
    const ids = Array.isArray(args.sourceDocumentIds)
      ? args.sourceDocumentIds.filter(
          (id): id is string => typeof id === "string" && UUID_RE.test(id)
        )
      : [];
    const reasoning =
      typeof args.reasoning === "string"
        ? args.reasoning.slice(0, 2000)
        : undefined;
    const [{ rerunSession }, { createHubProtocolCallerContext }] =
      await Promise.all([
        import("../../../services/focus-sessions/rerun-session.js"),
        import("../../hub-protocol/utils.js"),
      ]);
    const callerContext = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      null,
      null,
      null,
      agentUserId ?? null
    );
    const result = await rerunSession({
      sessionId,
      userId,
      mode: args.mode,
      ...(ids.length > 0 ? { scope: { sourceDocumentIds: ids } } : {}),
      dryRun,
      ...(reasoning ? { reason: reasoning } : {}),
      agentUserId: agentUserId ?? null,
      callerContext,
    });
    return ok(result);
  },
  synap_get_session: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // `resolveAmbientSession` now always answers when ANY session is open (it
    // picks the newest and reports `ambiguous`), so the old "multiple open →
    // refuse and list them" branch here is unreachable: it could only fire when
    // the resolver returned undefined, which now means zero open sessions.
    // Deleted rather than left behind a flag — two live definitions of what
    // ambiguity means is exactly the two-store divergence this codebase keeps
    // getting bitten by. The disclosure lives on the answer instead.
    const explicitId =
      typeof args.sessionId === "string" && args.sessionId.trim() !== ""
        ? args.sessionId
        : undefined;
    const ambient = explicitId
      ? undefined
      : await resolveAmbientSession(userId);
    const wantedId = explicitId ?? ambient?.sessionId;
    if (!wantedId) {
      return ok({
        session: null,
        message:
          "You have no open focus session. Start one with synap_start_session.",
      });
    }
    const [session] = await db
      .select()
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, wantedId), eq(focusSessions.userId, userId))
      )
      .limit(1);
    if (!session) {
      return ok({ error: `Focus session ${wantedId} not found` });
    }
    // Disclose an inferred answer. Asking "which session am I in?" and getting a
    // confident one back while three are open is precisely the mis-attribution
    // the old refusal guarded against — the fix is to answer AND say it was
    // inferred, not to withhold the answer.
    // Detour lineage, DERIVED from the `spawned_from` edge — never a column, so
    // there is exactly one store for "what was this forked from". ONE
    // projection, shared with the tRPC `focusSessions.get`.
    // The continuation packet — the SAME projection tRPC `focusSessions.get`
    // returns (founder decision D4: always included on a session read).
    const { projectContinuationPacket } =
      await import("../../../services/focus-sessions/continuation-packet.js");
    return ok({
      session: await withParentSessionId(session),
      continuation: await projectContinuationPacket(session, { userId }),
      ...(ambient?.ambiguous
        ? {
            inferred: true,
            openCount: ambient.openCount,
            message: `${ambient.openCount} sessions are open — this is the most recently started. Pass sessionId to ask about another.`,
          }
        : {}),
    });
  },
  synap_list_sessions: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const statusArg = (args.status as string | undefined) ?? "open";
    const conditions = [eq(focusSessions.userId, userId)];
    if (statusArg === "open") {
      conditions.push(
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      );
    } else if (statusArg !== "all") {
      // MCP schemas are ADVISORY — nothing validates `status` server-side, so
      // an off-enum value ("done", "completed") would silently match zero rows
      // instead of telling the agent what it may ask for.
      if (!(SESSION_STATUSES as readonly string[]).includes(statusArg)) {
        return ok({
          error: `Unknown session status '${statusArg}'. Valid values: ${SESSION_STATUSES.join(", ")}, plus 'open' (any non-terminal) and 'all'.`,
        });
      }
      conditions.push(
        eq(
          focusSessions.status,
          statusArg as (typeof focusSessions.$inferSelect)["status"]
        )
      );
    }
    // The URL lens auto-injects workspaceId/projectId — honoured as filters,
    // never as an authorization boundary (userId above is the floor).
    if (typeof args.workspaceId === "string" && args.workspaceId) {
      conditions.push(eq(focusSessions.workspaceId, args.workspaceId));
    }
    if (typeof args.projectId === "string" && args.projectId) {
      conditions.push(eq(focusSessions.projectId, args.projectId));
    }
    if (typeof args.subjectEntityId === "string" && args.subjectEntityId) {
      conditions.push(eq(focusSessions.subjectEntityId, args.subjectEntityId));
    }
    // Flow DEFINITION filters — the same two the tRPC and Hub REST doors take.
    // Each names a definition, never one execution. Pair with kind 'run' or
    // 'all': every flow-linked row classifies as a run, so under 'work' either
    // filter alone returns nothing.
    if (typeof args.playbookId === "string" && args.playbookId) {
      conditions.push(eq(focusSessions.playbookId, args.playbookId));
    }
    if (typeof args.automationId === "string" && args.automationId) {
      conditions.push(sessionAutomationWhere(args.automationId));
    }
    // Population lens (`services/focus-sessions/session-kind.ts`). MCP schemas
    // are ADVISORY — nothing validates args server-side — so an off-enum value
    // is answered with the vocabulary rather than silently matching zero rows.
    // Default `all`, like the Hub REST door and unlike tRPC's `work`: an agent
    // listing sessions wants the runs and write receipts it just opened.
    const kindArg = (args.kind as string | undefined) ?? "all";
    if (kindArg !== "all") {
      if (!(SESSION_KINDS as readonly string[]).includes(kindArg)) {
        return ok({
          error: `Unknown session kind '${kindArg}'. Valid values: ${SESSION_KINDS.join(", ")}, plus 'all'.`,
        });
      }
      conditions.push(
        sessionKindWhere(kindArg as (typeof SESSION_KINDS)[number])
      );
    }
    const rawLimit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? args.limit
        : 20;
    const sessions = await db
      .select()
      .from(focusSessions)
      .where(and(...conditions))
      .orderBy(desc(focusSessions.startedAt))
      .limit(Math.min(Math.max(Math.trunc(rawLimit), 1), 50));
    // Derived lineage for the whole page in ONE query (never N+1, never a
    // column) — the same projection the tRPC `focusSessions.list` uses.
    //
    // `triage` rides along for the SAME reason it does there: it is pure (no
    // query), and an agent that had to re-derive "is this waiting on a human?"
    // from origin + status + metadata would be writing the second, drifting
    // copy of a predicate that `services/focus-sessions/triage.ts` owns.
    //
    // No `lens` here on purpose. The tRPC door's default EXCLUDES triage rows
    // because a person's working list must not fill with drafts they never
    // asked for; an agent listing sessions is usually looking for the ones it
    // just opened, so hiding them would be the wrong default at this door.
    // The flag makes the distinction visible either way.
    // `kind` rides along on every row for the same reason `triage` does: pure,
    // no query, and the ONE place the predicate is decided.
    return ok({
      sessions: attachSessionKind(
        attachTriage(await attachParentSessionIds(sessions))
      ),
      count: sessions.length,
    });
  },
  synap_update_session: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const {
      updateFocusSession,
      expectedOutputWireSchema,
      outputRefWireSchema,
    } = await import("../../../services/focus-sessions/update-session.js");
    const slots = parseSlotInputs(args, {
      expectedOutputWireSchema,
      outputRefWireSchema,
    });
    if ("error" in slots) return ok(slots);
    const result = await updateFocusSession({
      sessionId: args.sessionId as string,
      userId,
      agentUserId,
      // NARROWED like `subjectEntityId` below: `null` CLEARS, a string renames,
      // anything else leaves the title alone. The length bound is the service's.
      ...(args.title === null
        ? { title: null }
        : typeof args.title === "string"
          ? { title: args.title }
          : {}),
      goal: args.goal as string | undefined,
      status: args.status as "active" | "paused" | undefined,
      progress: args.progress as number | undefined,
      currentStage: args.currentStage as string | undefined,
      addOutput: slots.addOutput,
      completeOutput: args.completeOutput as string | undefined,
      addAgentId: args.addAgentId as string | undefined,
      // NARROWED, not cast: this field has THREE meanings on the wire and a
      // blanket cast collapses two of them. `undefined` leaves the anchor,
      // `null` is the CLEAR, a string re-points it. `as string | null |
      // undefined` would let a number or an object through to the column.
      // The visibility floor is NOT re-applied here — it lives in
      // `updateFocusSession`, which is the one door every caller of this
      // service passes through; a second copy at this handler is exactly the
      // fork that made the output-ref check drift across doors.
      ...(args.subjectEntityId === null
        ? { subjectEntityId: null }
        : typeof args.subjectEntityId === "string"
          ? { subjectEntityId: args.subjectEntityId }
          : {}),
      // PARSED by the SHARED wire schema (see `parseSlotInputs`), never a
      // re-typed inline shape: an inline copy silently narrows what this door
      // believes a slot is, which is how the per-door shapes drifted in the
      // first place — and a cast narrows nothing while checking nothing.
      expectedOutputs: slots.expectedOutputs,
    });
    switch (result.status) {
      case "not_found":
        return ok({
          error: `Focus session ${args.sessionId as string} not found`,
        });
      case "denied":
        return ok({ error: result.reason });
      case "proposed":
        return ok({
          status: "proposed",
          message: proposedMessageFor(
            (result as { proposalType?: string }).proposalType,
            "Focus session update proposed for review"
          ),
          proposalId: result.proposalId,
          summary: result.summary,
          reviewPath: result.reviewPath,
          reviewUrl: result.reviewUrl,
          session: null,
        });
      case "updated":
        // `completeOutput` rides the SUCCESS response, not an error: the rest
        // of the patch landed. Without it a refused mark is indistinguishable
        // from a completed one — the row simply comes back unchanged and the
        // agent reads that as done.
        return ok({
          status: "updated",
          session: result.session,
          ...(result.completeOutput
            ? { completeOutput: result.completeOutput }
            : {}),
          // Same reason as `completeOutput`: a guideline covering the block
          // this patch declared must reach the agent that declared it.
          ...(result.blockGuidelines
            ? { blockGuidelines: result.blockGuidelines }
            : {}),
        });
    }
    // Defensive: an unhandled decision must NOT fall through — every
    // FocusSessionUpdateResult status is handled above (exhaustive switch).
  },
};
