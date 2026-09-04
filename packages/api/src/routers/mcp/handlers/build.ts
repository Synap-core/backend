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
import { playbooksRouter } from "../../playbooks.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import { resolveProposalId } from "../../hub-protocol/rest/_shared.js";
import { type ProposalRejectionReasonCode } from "@synap-core/types/proposals";
import { getDb, entities, focusSessions, eq } from "@synap/database";
import { skillsRouter as regularSkillsRouter } from "../../skills.js";
import {
  ok,
  requireScope,
  rejectMissingWriteWorkspace,
  resolveEntityWorkspaceId,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";
import type { PlaybookStageInput } from "../../../schemas/playbook-stage.js";

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
      data: {
        name: parsed.data.name,
        rendererSource: parsed.data.rendererSource,
        workspaceId: cellWorkspaceId,
        description: parsed.data.description ?? null,
        // Carried so the `cell/define` approve-executor materializes the
        // view-renderer affinity on approval, not just the source.
        ...(parsed.data.viewTypes ? { viewTypes: parsed.data.viewTypes } : {}),
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
    });
    return ok(result);
  },
  synap_list_playbooks: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      confinedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // User-floor catalog via `listAllPage` — no membership[0] fallback.
    // Visibility is the access-layer predicate (member workspaces + pod-wide).
    // Optional workspaceId narrows only (still includes pod-wide NULL rows).
    const playbookCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      null,
      undefined,
      undefined,
      agentUserId
    );
    const playbookCaller = playbooksRouter.createCaller(playbookCtx);
    // Narrow only on an explicit/confined workspaceId — not advisory focus
    // (focus is a write default; catalog stays full user floor unless asked).
    const result = await playbookCaller.listAllPage({
      workspaceId: confinedWorkspaceId ?? null,
      status: args.status as
        "draft" | "active" | "paused" | "archived" | undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    return ok(result);
  },
  synap_match_playbooks: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
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
    const result = await matchCaller.matchForEntity({
      profileSlug: args.profileSlug as string,
      entityId: args.entityId as string | undefined,
      workspaceId: matchWsId,
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
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      sessionId,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (typeof args.name !== "string" || args.name.trim() === "") {
      return ok({ error: "name is required" });
    }
    if (
      typeof args.goalTemplate !== "string" ||
      args.goalTemplate.trim() === ""
    ) {
      return ok({ error: "goalTemplate is required" });
    }
    // WRITE: confined/explicit lens or advisory focus only — never membership[0].
    const pbWsId = requestedWorkspaceId;
    if (!pbWsId) {
      return rejectMissingWriteWorkspace(userId);
    }
    const pbCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      pbWsId,
      undefined,
      sessionId,
      agentUserId
    );
    const pbCaller = playbooksRouter.createCaller(pbCtx);
    const result = await pbCaller.create({
      name: args.name as string,
      goalTemplate: args.goalTemplate as string,
      description: args.description as string | undefined,
      // `playbooks.create` validates these with `playbookStagesSchema`
      // (category required, keys unique); this only types the untyped args.
      stages: args.stages as PlaybookStageInput[] | undefined,
      // Default to `active` so a created template is immediately runnable via
      // synap_start_session(templateId) — a draft would be invisible to run.
      status:
        (args.status as
          "draft" | "active" | "paused" | "archived" | undefined) ?? "active",
      agentUserId,
    });
    return ok(result);
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
      ...(agentUserId ? { agentUserId } : {}),
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
    return ok(result);
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
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (args.summary === undefined && args.reasoning === undefined) {
      return ok({ error: "Provide at least one of: summary, reasoning" });
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
      actorId: userId,
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
    const {
      toolName,
      args,
      userId,
      apiKeyScopes,
      agentUserId,
      sessionId,
      requestedWorkspaceId,
    } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const rawPlaybookId =
      typeof args.playbookId === "string" && args.playbookId.trim() !== ""
        ? args.playbookId.trim()
        : undefined;
    // Accept playbookName OR name (alias) when id is absent.
    const rawPlaybookName =
      typeof args.playbookName === "string" && args.playbookName.trim() !== ""
        ? args.playbookName.trim()
        : typeof args.name === "string" && args.name.trim() !== ""
          ? args.name.trim()
          : undefined;
    if (!rawPlaybookId && !rawPlaybookName) {
      return ok({
        error:
          "playbookId or playbookName (or name) is required — discover via synap_list_playbooks",
      });
    }

    const {
      resolvePlaybookByIdVisible,
      resolvePlaybookByPublicName,
      resolvePlaybookRunWriteWorkspace,
    } = await import("../../../services/playbooks/resolve-playbook-name.js");

    // Resolve the playbook on the user floor (id or unambiguous public name).
    let resolvedPlaybookId: string;
    let playbookWorkspaceId: string | null;
    if (rawPlaybookId) {
      const byId = await resolvePlaybookByIdVisible({
        userId,
        playbookId: rawPlaybookId,
        agentUserId,
      });
      if (!byId) {
        return ok({ error: `Playbook ${rawPlaybookId} not found` });
      }
      resolvedPlaybookId = byId.id;
      playbookWorkspaceId = byId.workspaceId;
    } else {
      // Full user floor (no workspace narrow) so names resolve pod-wide.
      // Multi-match returns candidates with workspaceId — never a silent pick.
      const byName = await resolvePlaybookByPublicName({
        userId,
        name: rawPlaybookName!,
        agentUserId,
      });
      if (byName.status === "not_found") {
        return ok({
          error: `No playbook named "${rawPlaybookName}" among your visible playbooks`,
        });
      }
      if (byName.status === "ambiguous") {
        return ok({
          error: `"${rawPlaybookName}" matches ${byName.candidates.length} playbooks — pass playbookId or a unique name.`,
          candidates: byName.candidates,
        });
      }
      resolvedPlaybookId = byName.playbook.id;
      playbookWorkspaceId = byName.playbook.workspaceId;
    }

    // Write home ladder: explicit/focus lens → playbook home → subject →
    // ambient session. Never membership[0]. Pod-wide playbooks with no home
    // reject with the available workspace list.
    let subjectWorkspaceId: string | null | undefined;
    let sessionWorkspaceId: string | null | undefined;
    const subjectIdArg =
      typeof args.subjectId === "string" && args.subjectId.trim() !== ""
        ? args.subjectId.trim()
        : undefined;
    const needsContextHome = !requestedWorkspaceId && !playbookWorkspaceId;
    if (needsContextHome && subjectIdArg) {
      const database = await getDb();
      const ent = await database.query.entities.findFirst({
        columns: { workspaceId: true },
        where: eq(entities.id, subjectIdArg),
      });
      subjectWorkspaceId = ent?.workspaceId ?? null;
    }
    if (needsContextHome && !subjectWorkspaceId && sessionId) {
      const database = await getDb();
      const sess = await database.query.focusSessions.findFirst({
        columns: { workspaceId: true },
        where: eq(focusSessions.id, sessionId),
      });
      sessionWorkspaceId = sess?.workspaceId ?? null;
    }
    const runWsId = resolvePlaybookRunWriteWorkspace({
      explicitWorkspaceId: requestedWorkspaceId,
      playbookWorkspaceId,
      subjectWorkspaceId,
      sessionWorkspaceId,
    });
    if (!runWsId) {
      return rejectMissingWriteWorkspace(userId);
    }

    const runCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      runWsId,
      undefined,
      sessionId,
      agentUserId
    );
    const runCaller = playbooksRouter.createCaller(runCtx);
    // GOVERNED (playbooksRouter.run → checkPermissionOrPropose { playbook, run }).
    // With agentUserId set, an agent launch returns status:"proposed" (no run
    // created); only on approval does runPlaybook execute. Same governance the
    // tRPC/UI run door enforces — never a direct-active bypass.
    const result = await runCaller.run({
      playbookId: resolvedPlaybookId,
      params: args.params as Record<string, unknown> | undefined,
      subjectId: subjectIdArg,
      agentIds: args.agentIds as string[] | undefined,
      source: "mcp",
      reasoning: args.reasoning as string | undefined,
      agentUserId,
    });
    return ok(result);
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
