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
import {
  getUserMemberWorkspaceIds,
  resolveProposalId,
} from "../../hub-protocol/rest/_shared.js";
import { type ProposalRejectionReasonCode } from "@synap-core/types/proposals";
import { getDb, entities, focusSessions, eq } from "@synap/database";
import { skillsRouter as regularSkillsRouter } from "../../skills.js";
import {
  ok,
  requireScope,
  rejectMissingWriteWorkspace,
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
    const { checkPermissionOrPropose } =
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
        message:
          "Cell definition proposed for review (AI-generated renderer source is governed) — it materializes on approval.",
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
    // the facet lens). First membership is catalog-only, not a write home —
    // not rejectMissingWrite. (list_playbooks uses listAllPage / user floor;
    // match still needs a concrete workspace for loadFacetSlugsBatch.)
    let matchWsId = args.workspaceId as string | undefined;
    if (!matchWsId) {
      const wsIds = await getUserMemberWorkspaceIds(userId);
      matchWsId = wsIds[0];
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
    const { toolName, args, userId, apiKeyScopes, agentUserId, sessionId } =
      ctx;
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
      // Session too, or this door and the REST door write two different row
      // shapes into the SAME channel: agent-attributed but session-blind here,
      // both there.
      ...(sessionId ? { sessionId } : {}),
    });
    return ok(result);
  },
  synap_revise_proposal: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const proposalId = args.proposalId as string;
    if (args.summary === undefined && args.reasoning === undefined) {
      return ok({ error: "Provide at least one of: summary, reasoning" });
    }
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
    if (typeof args.code !== "string" || args.code.trim() === "") {
      return ok({
        error:
          "code is required — synap_create_skill authors a runnable (sandboxed) code skill. For a declarative provider-HTTP verb use synap_create_verb instead.",
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
    // With agentUserId set, an agent create returns status:"proposed". On
    // approval the code skill is born UNAPPROVED (approved = kind==="instruction"
    // → false for code): it does NOT load or run as an agent tool until the
    // owner explicitly approves it. Same governance every skill-create door uses.
    const result = await skillsCaller.create({
      workspaceId: skillWorkspaceId,
      kind: "code",
      scope: skillWorkspaceId ? "workspace" : "pod",
      name: args.name,
      description: args.description as string | undefined,
      body: args.body as string | undefined,
      code: args.code,
      parameters: args.parameters as Record<string, unknown> | undefined,
      agentUserId: agentUserId ?? undefined,
    });
    return ok(result);
  },
};
