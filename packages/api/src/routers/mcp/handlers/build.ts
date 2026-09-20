/**
 * MCP tool handlers — build domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { z } from "zod";
import { toolError } from "../tool-errors.js";
import { playbooksRouter } from "../../playbooks.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { toViewDigest, VIEWS_DIGEST_NOTE } from "./read-lean.js";
import { resolveProposalId } from "../../hub-protocol/rest/_shared.js";
import { type ProposalRejectionReasonCode } from "@synap-core/types/proposals";
import { CONTENT_KINDS } from "@synap/database/schema";
import { getDb } from "@synap/database";
import { skillsRouter as regularSkillsRouter } from "../../skills.js";
import {
  ok,
  requireScope,
  readReasoning,
  rejectMissingWriteWorkspace,
  resolveEntityWorkspaceId,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";
import type { PlaybookStageInput } from "../../../schemas/playbook-stage.js";
import type { ProposalRevisionPatch } from "../../../services/proposals/proposals-service.js";
import {
  createPlaybookDoor,
  listPlaybooksDoor,
  runPlaybookDoor,
  type PlaybookDoorIdentity,
  type PlaybookDoorOutcome,
} from "../../hub-protocol/playbook-doors.js";
import {
  compactScorecard,
  computePlaybookScorecards,
} from "@synap/jobs/utils/playbook-scorecard.js";

function playbookDoorIdentity(ctx: McpToolContext): PlaybookDoorIdentity {
  return {
    userId: ctx.userId,
    scopes: ctx.apiKeyScopes,
    agentUserId: ctx.agentUserId,
    sessionId: ctx.sessionId,
    keyType: ctx.keyType,
    keyWorkspaceId: ctx.keyWorkspaceId,
  };
}

/** This door's rendering of a shared playbook-door outcome. */
async function renderPlaybookDoorOutcome<T>(
  outcome: PlaybookDoorOutcome<T>,
  userId: string
): Promise<CallToolResult> {
  switch (outcome.kind) {
    case "result":
      return ok(outcome.result);
    case "missing_workspace":
      return rejectMissingWriteWorkspace(userId);
    case "invalid":
      return ok({
        error: outcome.error,
        ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
      });
    case "not_found":
      return ok({ error: outcome.error });
  }
}

/**
 * Shape of `synap_revise_proposal`'s optional `patch` — mirrors
 * `ProposalRevisionPatch`, the type the shared revise core consumes.
 *
 * `kind: "inner"` edits the entity-level fields the executor reads;
 * `kind: "envelope"` edits the top-level envelope. Both are already supported by
 * `mergeProposalRevision`; this door simply had no way to express either, so an
 * agent could only ever rewrite the narrative and never the payload it described.
 */
const REVISE_PATCH_SCHEMA = z.object({
  kind: z.enum(["inner", "envelope"]),
  fields: z.record(z.string(), z.unknown()),
});

export const buildHandlers: McpHandlerMap = {
  synap_create_cell: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // Validate the shape before trusting the cast args (defineCell handles the
    // npm-dep allowlist itself — this only guards the required primitives).
    const parsed = z
      .object({
        name: z.string().min(1),
        rendererSource: z.string().min(1),
        workspaceId: z.string().optional(),
        description: z.string().optional(),
        /** View-type affinity for using this cell as a view renderer (0221). */
        viewTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
        /**
         * Renderer SLOT. `defineCell` has always accepted this; NO write door
         * declared it, and a plain z.object STRIPS an undeclared key — so an
         * agent sending `contentKind` got a success and a cell that silently
         * took the column default `widget`, invisible to `renderersForType`.
         * Enum built from the `CONTENT_KINDS` runtime SSOT, never retyped.
         */
        contentKind: z.enum(CONTENT_KINDS).optional(),
      })
      .safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `Invalid synap_create_cell args: ${parsed.error.issues
          .map((i) => i.message)
          .join(", ")}`
      );
    }
    const cellWorkspaceId = parsed.data.workspaceId ?? null;
    // Route through the governance gate — it owns RBAC (workspace membership +
    // role, or the agent-join proposal for a non-member) AND the agent
    // propose/execute decision. No manual verifyWorkspaceAccess: that would
    // hard-deny an agent the gate would otherwise let PROPOSE.
    const { checkPermissionOrPropose, proposedMessageFor } =
      await import("../../../utils/permission-check.js");
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId: agentUserId ?? undefined,
      workspaceId: cellWorkspaceId ?? undefined,
      subjectType: "cell",
      action: "define",
      source: "api",
      // The agent's own WHY, verbatim. Without it the gate stores the
      // placeholder "<action> <type> requires your approval", which the review
      // UI suppresses — the reviewer then reads "No reason was given".
      ...(readReasoning(args) ? { reasoning: readReasoning(args) } : {}),
      data: {
        name: parsed.data.name,
        rendererSource: parsed.data.rendererSource,
        workspaceId: cellWorkspaceId,
        description: parsed.data.description ?? null,
        // Carried so the `cell/define` approve-executor materializes the
        // view-renderer affinity on approval, not just the source.
        ...(parsed.data.viewTypes ? { viewTypes: parsed.data.viewTypes } : {}),
        // Same reason as `viewTypes`: without it an APPROVED cell materializes
        // into the default `widget` slot — the reviewer approves an
        // entity-detail renderer and the pod writes a bento widget.
        ...(parsed.data.contentKind
          ? { contentKind: parsed.data.contentKind }
          : {}),
      },
    });
    if ("denied" in perm && perm.denied) {
      return ok({ error: perm.reason, denied: true });
    }
    if (
      "proposalId" in perm &&
      perm.proposalId &&
      !("granted" in perm && perm.granted)
    ) {
      return ok({
        status: "proposed",
        message: proposedMessageFor(
          perm.proposalType,
          "Cell definition proposed for review (AI-generated renderer source is governed) — it materializes on approval."
        ),
        proposalId: perm.proposalId,
        summary: perm.summary,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
        ...(perm.deduped ? { deduped: true } : {}),
      });
    }
    // Granted (operator authority) → apply inline via the ONE door.
    const { defineCell } =
      await import("../../../services/cells/define-cell.js");
    const result = await defineCell({
      name: parsed.data.name,
      rendererSource: parsed.data.rendererSource,
      workspaceId: cellWorkspaceId,
      description: parsed.data.description,
      viewTypes: parsed.data.viewTypes,
      contentKind: parsed.data.contentKind,
      userId,
    });
    return ok({ status: result.changeType, ...result });
  },
  synap_promote_cell_to_renderer: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // Governed: for an AI agent this returns `status: 'proposed'` (binding an
    // AI-generated cell as a durable renderer is consequential); an operator
    // auto-applies.
    const result = await caller.profiles.setRenderer({
      userId,
      workspaceId: args.workspaceId as string | undefined,
      profileSlug: args.profileSlug as string,
      slot: args.slot as "list" | "detail" | "dashboard",
      cellKey: args.cellKey as string,
      props: args.props as Record<string, unknown> | undefined,
      scope: args.scope as "workspace" | "pod" | undefined,
      ...(agentUserId ? { agentUserId } : {}),
      // `profiles.setRenderer` has declared `reasoning` since it was written
      // and forwards it into the gate; this door never sent one.
      ...(readReasoning(args) ? { reasoning: readReasoning(args) } : {}),
    });
    return ok(result);
  },
  synap_promote_session_to_playbook: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // Governed via the regular `playbooks.promote` — agent → proposed,
    // operator → promoted.
    const result = await caller.playbooks.promote({
      userId,
      sessionId: args.sessionId as string,
      ...(agentUserId ? { agentUserId } : {}),
      ...(readReasoning(args) ? { reasoning: readReasoning(args) } : {}),
    });
    return ok(result);
  },
  synap_list_playbooks: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, apiKeyScopes, confinedWorkspaceId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // User-floor catalog (member workspaces + pod-wide) through the shared list
    // door. Narrow only on an explicit/confined workspaceId — not advisory
    // focus (focus is a write default; catalog stays full user floor).
    const result = await listPlaybooksDoor(playbookDoorIdentity(ctx), {
      workspaceId: confinedWorkspaceId ?? null,
      status: args.status as
        "draft" | "active" | "paused" | "archived" | undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
      cursor: typeof args.cursor === "string" ? args.cursor : undefined,
    });
    // How each of these has actually gone for this person — two queries for
    // the whole page (never one per row). A playbook with no closed run gets
    // no entry; zeroes would be noise. The SAME derivation the tRPC
    // `playbooks.scorecard` and the lessons scanner read.
    const scorecards = await computePlaybookScorecards(await getDb(), {
      playbookIds: result.playbooks.map((p) => p.id),
      userId: ctx.userId,
    });
    return ok({
      ...result,
      playbooks: result.playbooks.map((p) => {
        const compact = compactScorecard(scorecards[p.id]!);
        return compact ? { ...p, scorecard: compact } : p;
      }),
    });
  },
  synap_match_playbooks: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // REFUSE A SIGNAL-LESS MATCH. Ranking needs something to rank AGAINST:
    // with no intentText, no profileSlug and no entityId, every active
    // playbook comes back at the ranker's floor score — a long, plausible,
    // meaningless list. Measured on the live pod: a caller that passed
    // `intent` instead of `intentText` got 15 candidates, all tied.
    //
    // This is the house error door (`toolError` → `isError: true` TEXT the
    // model can act on and retry, never a JSON-RPC crash), and the message
    // names the argument AND the other door, because "you gave me nothing" is
    // only useful to a caller who is told what to give.
    //
    // Boundary, stated: this catches a call with NO signal. A mistyped
    // argument alongside a real one (e.g. `intent` + `profileSlug`) still
    // ranks on what it understood — nothing in the MCP layer rejects an
    // unknown key today. See the report accompanying this change.
    const hasSignal = (["intentText", "profileSlug", "entityId"] as const).some(
      (k) => typeof args[k] === "string" && (args[k] as string).trim()
    );
    if (!hasSignal) {
      return toolError(
        `Tool '${toolName}' needs something to match against. Pass intentText (what the user said — note the spelling, not 'intent'), and/or profileSlug (the kind of thing, e.g. 'post'), and/or entityId. ` +
          `Without one of those every active playbook ties at the same score, which is not a match. To simply see the playbooks that exist, call synap_list_playbooks instead.`
      );
    }
    // READ: matchForEntity is a workspaceProcedure (needs a ctx workspace for
    // the facet lens) — "pod-wide" isn't available to it the way it is for
    // synap_ask. HONEST FALLBACK, same shape as synap_get_relations: when the
    // caller names an entityId but no workspaceId, the entity's OWN workspace
    // is the right lens — not an arbitrary member workspace, which matches
    // playbooks (and widens via facet slugs) against the wrong home. Only
    // fall back to the first-membership pick — and disclose it — when the
    // entity's workspace can't be resolved (no entityId, deleted, pod-global,
    // or not visible to this caller). That old pick is catalog-only, not a
    // write home, so it stays the honest floor for the entity-less case.
    let matchWsId = args.workspaceId as string | undefined;
    let autoPicked = false;
    let memberCount = 0;
    if (!matchWsId) {
      const resolved = await resolveEntityWorkspaceId(
        userId,
        args.entityId as string | undefined
      );
      matchWsId = resolved.workspaceId;
      autoPicked = resolved.autoPicked;
      memberCount = resolved.memberCount;
    }
    if (!matchWsId) return ok({ error: "No accessible workspace found" });
    const matchCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      matchWsId,
      undefined,
      undefined,
      agentUserId
    );
    const matchCaller = playbooksRouter.createCaller(matchCtx);
    const profileSlug =
      typeof args.profileSlug === "string" && args.profileSlug.trim()
        ? args.profileSlug.trim()
        : undefined;
    const result = await matchCaller.matchForEntity({
      ...(profileSlug ? { profileSlug } : {}),
      entityId: args.entityId as string | undefined,
      workspaceId: matchWsId,
      // Ranks, never filters: each candidate comes back with `score` + `reason`.
      ...(typeof args.intentText === "string" && args.intentText.trim()
        ? { intentText: args.intentText.slice(0, 2000) }
        : {}),
    });
    // Only reshape in the AMBIGUOUS case (auto-picked among several member
    // workspaces) — the explicit-workspaceId and resolved-entity-workspace
    // paths stay byte-identical to the prior array shape.
    if (autoPicked && memberCount > 1) {
      const note = `The entity's own workspace could not be resolved, so playbooks were matched against ONE workspace (${matchWsId}) of your ${memberCount} member workspaces. If this looks incomplete, the entity's real workspace may differ — pass an explicit workspaceId to scope deliberately.`;
      return ok({ playbooks: result, scopedWorkspaceId: matchWsId, note });
    }
    return ok(result);
  },
  synap_create_playbook: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, requestedWorkspaceId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // WRITE: confined/explicit lens or advisory focus only — never membership[0].
    const outcome = await createPlaybookDoor(playbookDoorIdentity(ctx), {
      workspaceId: requestedWorkspaceId,
      name: args.name,
      goalTemplate: args.goalTemplate,
      description: args.description as string | undefined,
      stages: args.stages as PlaybookStageInput[] | undefined,
      status: args.status as
        "draft" | "active" | "paused" | "archived" | undefined,
    });
    return renderPlaybookDoorOutcome(outcome, userId);
  },
  synap_create_view: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      caller,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const result = await caller.views.createView({
      userId,
      // Confined workspace (service-key clamp) — not the raw model-supplied id.
      workspaceId: requestedWorkspaceId as string,
      name: args.name as string,
      type: args.type as string,
      profileId: args.profileId as string | undefined,
      config: args.config as Record<string, unknown> | undefined,
      // Canvas seed for type: "whiteboard" — the only door that can put shapes
      // on a board at create time. Undefined for every structured view.
      ...(args.initialContent !== undefined
        ? { initialContent: args.initialContent }
        : {}),
      ...(agentUserId ? { agentUserId } : {}),
      ...(typeof args.expectedLabel === "string"
        ? { expectedLabel: args.expectedLabel }
        : {}),
      ...(readReasoning(args) ? { reasoning: readReasoning(args) } : {}),
    });
    return ok(result);
  },
  synap_list_views: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      caller,
      confinedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // Owner-only floor lives in hub listViews — do not widen it here.
    // Narrow only on an explicit/confined workspaceId — not advisory focus
    // (focus is a write default; catalog stays full user floor unless asked).
    const result = await caller.views.listViews({
      userId,
      workspaceId: confinedWorkspaceId ?? null,
      type: typeof args.type === "string" ? args.type : undefined,
      profileId:
        typeof args.profileId === "string" ? args.profileId : undefined,
    });
    if (args.detail === "full" || !Array.isArray(result)) return ok(result);
    return ok({
      views: (result as Array<Record<string, unknown>>).map(toViewDigest),
      note: VIEWS_DIGEST_NOTE,
    });
  },
  synap_list_widgets: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, apiKeyScopes, caller, confinedWorkspaceId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const { COMPOSE_WIDGET_CATALOG } =
      await import("../../../services/cells/compose-widget-catalog.js");
    const workspaceId =
      confinedWorkspaceId ??
      (typeof args.workspaceId === "string" ? args.workspaceId : null);
    const rows = (await caller.widgetDefinitions.listWidgetDefs({
      workspaceId,
    })) as Array<Record<string, unknown>>;
    const generated = rows
      .filter(
        (row) =>
          row.source !== "compose-catalog" &&
          typeof row.typeKey === "string" &&
          (String(row.typeKey).startsWith("generated:") ||
            row.rendererType === "frame")
      )
      .map((row) => ({
        key: row.typeKey,
        name: row.name,
        description: row.description ?? "",
        rendererType: row.rendererType,
        workspaceId: row.workspaceId ?? null,
      }));
    return ok({
      builtins: COMPOSE_WIDGET_CATALOG.filter((w) => !w.aliasOf),
      aliases: COMPOSE_WIDGET_CATALOG.filter((w) => w.aliasOf),
      generated,
      notes: [
        "Never guess a widget key — use this list.",
        "view / view-table / view-* require config.viewId (a saved view UUID). profileSlug is not enough.",
        "Counts: stat-card + profileSlug. entity-count is a legacy alias.",
        "Profile-scoped collections without a saved view: entity-list + profileSlug.",
      ],
    });
  },
  synap_post_message: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const { postChannelMessage } =
      await import("../../../services/messaging/post-message.js");
    const result = await postChannelMessage({
      // Idempotency: an explicit key (or the door's content-hash fallback)
      // makes a retry of a "failed" post return the prior message, not a dupe.
      idempotencyKey: args.idempotencyKey as string | undefined,
      channelId: args.channelId as string,
      content: args.content as string,
      role: args.role as string | undefined,
      triggerAI: Boolean(args.triggerAI),
      userId,
      // `userId` is the human OWNER even on an agent key. Pass the agent
      // principal so the row records WHICH agent posted — otherwise every agent
      // in a shared channel writes an identical-looking message.
      ...(agentUserId ? { agentUserId } : {}),
    });
    return ok(result);
  },
  synap_revise_proposal: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    // `agentUserId` is the ACTING AGENT principal (RFC 8693 `act`) — the same
    // field every other `synap_*` write handler destructures, and the ONE this
    // one was missing. Without it the door could only ever present the HUMAN as
    // the actor, so an agent amending its own pending proposal was gated by the
    // human REVIEWER ladder it has no business satisfying. Enables the author
    // rung in `mergeProposalRevision`; never fed to the reviewer ladder.
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (
      args.summary === undefined &&
      args.reasoning === undefined &&
      args.patch === undefined
    ) {
      return ok({
        error: "Provide at least one of: summary, reasoning, patch",
      });
    }
    // `patch` lets an agent amend WHAT WILL BE CREATED, not just the narrative a
    // human reads. Validated rather than cast: a malformed patch must be a clear
    // error, never a silently-dropped field that leaves the summary describing a
    // payload nobody changed.
    let patch: ProposalRevisionPatch | undefined;
    if (args.patch !== undefined) {
      const parsed = REVISE_PATCH_SCHEMA.safeParse(args.patch);
      if (!parsed.success) {
        return ok({
          error:
            'Invalid patch. Expected { kind: "inner" | "envelope", fields: object }.',
        });
      }
      patch = parsed.data;
    }
    // Short-id parity with the sibling `synap_reject_proposal`: accepts the
    // 8-char id `synap_list_proposals` / the CLI prints, not just a full uuid
    // (a bare prefix in a `WHERE id = $1` uuid lookup throws).
    const proposalId = await resolveProposalId(
      userId,
      args.proposalId as string
    );
    // AUTHORITY: unlike `reject` (which routes through
    // `proposalsRouter.createCaller().reject()`), this door cannot go through
    // the tRPC `proposals.revise` procedure — that one's input has no
    // `summary`/`reasoning` and applies an ENVELOPE data patch, so it cannot
    // express a summary/reasoning-only revision. The reviewer-authority
    // predicate therefore lives INSIDE the shared revise core
    // (`mergeProposalRevision`, which `reviseProposal` wraps), so this door, the
    // Hub door and the tRPC door are gated by the ONE ladder
    // (`computeCanReviewApproval`) and cannot drift apart.
    const { reviseProposal } =
      await import("../../../services/proposals/proposals-service.js");
    await reviseProposal({
      proposalId,
      summary: args.summary as string | undefined,
      reasoning: args.reasoning as string | undefined,
      patch,
      actorId: userId,
      // The author rung: authorizes an agent amending the proposal IT authored.
      ...(agentUserId ? { actingAgentUserId: agentUserId } : {}),
    });
    return ok({ success: true, proposalId });
  },
  synap_reject_proposal: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // Accepts the 8-char short id `synap_list_proposals` / the CLI print, not
    // just a full uuid (a bare prefix in a `WHERE id = $1` uuid lookup throws).
    const resolvedProposalId = await resolveProposalId(
      userId,
      args.proposalId as string
    );
    const rejectCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      undefined,
      undefined,
      undefined,
      agentUserId
    );
    const { proposalsRouter } = await import("../../proposals.js");
    const rejectCaller = proposalsRouter.createCaller(
      rejectCtx as Parameters<typeof proposalsRouter.createCaller>[0]
    );
    await rejectCaller.reject({
      proposalId: resolvedProposalId,
      reason: args.reason as string | undefined,
      // Structured cause (0232) — validated against PROPOSAL_REJECTION_REASONS
      // by the reject procedure's zod enum; an unknown value is rejected there.
      reasonCode: args.reasonCode as ProposalRejectionReasonCode | undefined,
    });
    return ok({ success: true, proposalId: resolvedProposalId });
  },
  synap_run_playbook: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, requestedWorkspaceId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const trimmed = (v: unknown) =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    // The shared run door (`hub-protocol/playbook-doors.ts`) — the same one Hub
    // REST `POST /playbooks/:id/run` calls. Name resolution, the write-home
    // ladder and the governed `playbooks.run` delegation live there once.
    const outcome = await runPlaybookDoor(playbookDoorIdentity(ctx), {
      workspaceId: requestedWorkspaceId,
      playbookId: trimmed(args.playbookId),
      // Accept playbookName OR name (alias) when id is absent.
      playbookName: trimmed(args.playbookName) ?? trimmed(args.name),
      subjectId: trimmed(args.subjectId),
      params: args.params as Record<string, unknown> | undefined,
      agentIds: args.agentIds as string[] | undefined,
      reasoning: args.reasoning as string | undefined,
      source: "mcp",
    });
    return renderPlaybookDoorOutcome(outcome, userId);
  },
  synap_create_skill: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId, sessionId } =
      ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (typeof args.name !== "string" || args.name.trim() === "") {
      return ok({ error: "name is required" });
    }
    // A skill is Documentation (always) + OPTIONAL code — the router derives
    // `kind` from code presence (`skills.ts`: hasCode ? "code" : "instruction").
    // So this door requires documentation-or-code, never code specifically: a
    // prose-only skill is a first-class teaching skill that `synap_load_skill`
    // resolves BY SLUG, which is why `slug` is required when there is no code.
    const skillCode =
      typeof args.code === "string" && args.code.trim() !== ""
        ? args.code
        : undefined;
    const skillBody =
      typeof args.body === "string" && args.body.trim() !== ""
        ? args.body
        : undefined;
    if (!skillCode && !skillBody) {
      return ok({
        error:
          "a skill needs documentation or code — pass `body` (Markdown) to author a teaching skill, `code` to author a runnable one, or both.",
      });
    }
    const skillSlug =
      typeof args.slug === "string" && args.slug.trim() !== ""
        ? args.slug.trim()
        : undefined;
    if (!skillCode && !skillSlug) {
      return ok({
        error:
          "slug is required for a documentation-only skill — it is the ref synap_load_skill resolves (e.g. 'biz/business-plan'). Without one the skill is authored but unreachable.",
      });
    }
    const skillWorkspaceId =
      typeof args.workspaceId === "string" ? args.workspaceId : undefined;
    const skillsCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      skillWorkspaceId ?? null,
      undefined,
      sessionId,
      agentUserId ?? null
    );
    const skillsCaller = regularSkillsRouter.createCaller(skillsCtx as never);
    // GOVERNED (skillsRouter.create → checkPermissionOrPropose { skill, create }).
    // With agentUserId set, an agent create returns status:"proposed". Either
    // way the skill is born UNAPPROVED whenever an agent authored it — code
    // executes, and instruction PROSE lands in a future agent's system prompt,
    // so both are born draft and need an explicit owner approval before they
    // run or load. `kind` is deliberately NOT passed: the router derives it from
    // code presence, so passing it here would fork that derivation.
    const result = await skillsCaller.create({
      workspaceId: skillWorkspaceId,
      scope: skillWorkspaceId ? "workspace" : "pod",
      slug: skillSlug,
      name: args.name,
      description: args.description as string | undefined,
      body: skillBody,
      code: skillCode,
      parameters: args.parameters as Record<string, unknown> | undefined,
      agentUserId: agentUserId ?? undefined,
    });
    return ok(result);
  },
};
