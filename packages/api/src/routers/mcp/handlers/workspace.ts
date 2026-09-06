/**
 * MCP tool handlers — workspace domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import {
  db,
  workspaces,
  projects,
  inArray,
  and,
  or,
  eq,
  isNull,
  isNotNull,
} from "@synap/database";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import { getUserMemberWorkspaceIds } from "../../hub-protocol/rest/_shared.js";
import {
  setAgentFocusWorkspace,
  setAgentFocusProject,
} from "../../../services/agent-identity-service.js";
import { matchFocusTarget, isClearFocusArg } from "./focus-target-match.js";
import { projectsRouter } from "../../projects.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import {
  ok,
  requireScope,
  rejectMissingWriteWorkspace,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";

export const workspaceHandlers: McpHandlerMap = {
  synap_orient: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const { discover } = await import("../../../services/discover/discover.js");
    const result = await discover({
      caller,
      userId,
      authScopes: apiKeyScopes,
      detail: (args.detail as "light" | "full" | undefined) ?? "light",
      scope: args.scope as
        Array<"workspaces" | "projects" | "profiles"> | undefined,
      workspaceId: args.workspaceId as string | undefined,
      projectId: args.projectId as string | undefined,
    });
    return ok(result);
  },
  synap_set_workspace_focus: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (!agentUserId) {
      return ok({
        error:
          "No agent identity on this key — workspace focus is per-agent and this call isn't authenticated as one.",
      });
    }
    const raw = typeof args.workspace === "string" ? args.workspace.trim() : "";
    if (raw === "" || /^(none|clear|null)$/i.test(raw)) {
      await setAgentFocusWorkspace(agentUserId, null);
      return ok({
        status: "cleared",
        message:
          "Workspace focus cleared — writes will resolve their own placement again.",
      });
    }

    // The user's own workspaces are the only valid targets (mirrors the
    // membership-only fallback the rest of the MCP adapter uses).
    const memberIds = await getUserMemberWorkspaceIds(userId);
    if (memberIds.length === 0) {
      return ok({ error: "You have no workspaces to focus on yet." });
    }
    const memberRows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, memberIds));

    // 1) exact id match among accessible workspaces
    let resolved = memberRows.find((w) => w.id === raw);
    // 2) exact case-insensitive name match — AMBIGUITY-CHECKED, like step 3.
    //
    // This used to be `.find()`, which returns the FIRST match and silently
    // discards the rest. Workspace names are NOT unique: the live pod carries
    // two "Foundation" and two "CRM". So "focus the Foundation workspace"
    // silently pinned whichever row came back first and reported success, and
    // every subsequent unqualified write landed in a workspace the caller did
    // not choose. Verified live before the fix.
    //
    // The ambiguity guard existed only on the SUBSTRING branch below, so an
    // EXACT duplicate never reached it. The test that covers this
    // (`__tests__/workspace-focus.test.ts`) used "CRM Sales"/"CRM Support"
    // queried as "CRM" — substring ambiguity — and never two identical names.
    //
    // `build.ts:518` states the house rule this now follows: "Multi-match
    // returns candidates … never a silent pick."
    if (!resolved) {
      const exactMatches = memberRows.filter(
        (w) => w.name.toLowerCase() === raw.toLowerCase()
      );
      if (exactMatches.length === 1) {
        resolved = exactMatches[0];
      } else if (exactMatches.length > 1) {
        return ok({
          error: `"${raw}" is the name of ${exactMatches.length} workspaces — pass the id.`,
          candidates: exactMatches.map((w) => ({ id: w.id, name: w.name })),
        });
      }
    }
    // 3) unique case-insensitive substring match
    if (!resolved) {
      const substringMatches = memberRows.filter((w) =>
        w.name.toLowerCase().includes(raw.toLowerCase())
      );
      if (substringMatches.length === 1) {
        resolved = substringMatches[0];
      } else if (substringMatches.length > 1) {
        return ok({
          error: `"${raw}" matches ${substringMatches.length} workspaces — be more specific or pass the id.`,
          candidates: substringMatches.map((w) => ({
            id: w.id,
            name: w.name,
          })),
        });
      }
    }
    if (!resolved) {
      return ok({
        error: `No workspace named "${raw}" among your workspaces.`,
        candidates: memberRows.map((w) => ({ id: w.id, name: w.name })),
      });
    }

    await setAgentFocusWorkspace(agentUserId, resolved.id);
    return ok({
      status: "focused",
      workspaceId: resolved.id,
      workspaceName: resolved.name,
      message: `Focused on ${resolved.name} — new writes will land there until you clear it.`,
    });
  },
  /**
   * synap_set_project_focus — the PROJECT DECLARATION channel.
   *
   * WHY THIS IS A DECLARATION AND NOT AN INFERENCE. `belongs_to_project` is a
   * whitelisted `EXPOSURE_RELATION_TYPE`, OR'd into the access floor, so filing
   * something into a project GRANTS ACCESS to it across workspaces. That is why
   * `resolveProjectPlacement` has NO AI rung and why it abstains rather than
   * defaulting. This tool does not soften that: a focus is only ever set by an
   * EXPLICIT call naming a project, which is rung-1-shaped intent arriving by a
   * sticky route. Nothing here — and nothing downstream of here — may infer a
   * project from content, titles, embeddings or similarity.
   *
   * WHY THE EXISTENCE CHECK IS AT SET TIME. `relations.target_entity_id` has no
   * FK to `projects`, so a focus pinned to a project that does not exist (or is
   * invisible to the caller) would later stamp a GHOST membership edge that the
   * project lens never resolves — "a SILENT DROP reported as `✓ stored`"
   * (`routers/capture.ts:2260-2273`). We therefore resolve the target out of the
   * caller's OWN visible project rows, loaded with the SAME pod-wide-owner /
   * workspace-member predicate `projects.ts` and the capture door already use.
   * A bare id that is not in that set is `not_found`, never trusted.
   *
   * Ambiguity is reported, never guessed — see `focus-target-match.ts`.
   */
  synap_set_project_focus: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    if (!agentUserId) {
      return ok({
        error:
          "No agent identity on this key — project focus is per-agent and this call isn't authenticated as one.",
      });
    }
    const raw = typeof args.project === "string" ? args.project.trim() : "";
    if (isClearFocusArg(raw)) {
      await setAgentFocusProject(agentUserId, null);
      return ok({
        status: "cleared",
        message:
          "Project focus cleared — writes stop declaring a project (placement abstains again).",
      });
    }

    // The caller's VISIBLE projects — the existence + visibility verification.
    // Same predicate as `projects.list` / `loadVisibleProject` / the capture
    // door: pod-wide projects (NULL workspace) only for their owner, and
    // workspace-scoped projects for workspace members. Never a new floor.
    const visibleProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, userId)
          )
        )!
      );
    if (visibleProjects.length === 0) {
      return ok({ error: "You have no projects to focus on yet." });
    }

    const match = matchFocusTarget(raw, visibleProjects);
    if (match.kind === "ambiguous") {
      return ok({
        error:
          match.matchedBy === "name"
            ? `"${raw}" is the name of ${match.candidates.length} projects — pass the id.`
            : `"${raw}" matches ${match.candidates.length} projects — be more specific or pass the id.`,
        candidates: match.candidates,
      });
    }
    if (match.kind === "not_found") {
      return ok({
        error: `No project named "${raw}" among the projects you can see.`,
        candidates: visibleProjects,
      });
    }

    await setAgentFocusProject(agentUserId, match.target.id);
    return ok({
      status: "focused",
      projectId: match.target.id,
      projectName: match.target.name,
      message: `Focused on project ${match.target.name} — writes that don't pin their own project will declare it until you clear it.`,
    });
  },
  synap_create_workspace: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const name = args.name as string | undefined;
    if (typeof name !== "string" || name.trim() === "") {
      return ok({ error: "name is required" });
    }
    const definition = (args.definition ?? {}) as object;
    const idempotencyKey = args.proposalId as string | undefined;
    const { checkPermissionOrPropose, proposedMessageFor } =
      await import("../../../utils/permission-check.js");
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId: agentUserId ?? undefined,
      subjectType: "workspace",
      action: "create",
      source: "api",
      data: {
        name,
        definition,
        workspaceName: name,
        proposalId: idempotencyKey,
        createdBy: "provisioning",
        source: "mcp.synap_create_workspace",
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
          "Workspace creation proposed for review (workspace invent is governed) — it materializes on approval."
        ),
        proposalId: perm.proposalId,
        summary: perm.summary,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
        ...(perm.deduped ? { deduped: true } : {}),
      });
    }
    // Granted (operator authority) → same materialize door as approve
    // (deps/compose aware). Do NOT use createWorkspaceFromDefinitionIdempotent
    // alone — it diverges from packages.apply / workspace/create approve.
    const { materializeWorkspaceCore } =
      await import("../../../services/workspace-materialization-service.js");
    const core = await materializeWorkspaceCore({
      definition: definition as Parameters<
        typeof materializeWorkspaceCore
      >[0]["definition"],
      userId,
      agentUserId: agentUserId ?? undefined,
      proposalId: idempotencyKey,
      workspaceName: name,
      createdBy: "provisioning",
    });
    if (core.status === "resolved") {
      return ok({
        error:
          "Workspace materialize returned resolved-without-create (unexpected)",
      });
    }
    return ok({
      status: "created",
      workspaceId: core.workspaceId,
      materializeStatus: core.status,
      created: core.status === "created",
    });
  },
  synap_declare_workspace_source: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const workspaceId = args.workspaceId as string | undefined;
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return ok({ error: "workspaceId is required" });
    }
    const { WorkspaceSourceEdgeInputSchema, mergeWorkspaceSourceEdges } =
      await import("../../../services/workspace-edge-service.js");
    const parsed = WorkspaceSourceEdgeInputSchema.safeParse({
      sourceRoles: args.sourceRoles,
      defaultSources: args.defaultSources,
    });
    if (!parsed.success) {
      return ok({
        error: "Invalid edge fields",
        details: parsed.error.issues,
      });
    }
    if (!parsed.data.sourceRoles && !parsed.data.defaultSources) {
      return ok({
        error: "Provide at least one of: sourceRoles, defaultSources",
      });
    }
    // GOVERNED write (Enterprise-OS Wave 0): declaring a data edge rewires
    // pod-wide cross-workspace read routing, so it goes through the review
    // membrane, not immediate apply. `checkPermissionOrPropose` runs the
    // canonical RBAC floor (action `declare_source` → "write" permission =
    // the same editor+ floor `assertWorkspaceWrite` enforced) and then the
    // agent-governance ladder: an agent-remapped key routes to a PROPOSAL
    // (declare_source is not auto-approved), while a plain operator (no
    // agentUserId, source "api") is the authority and is GRANTED. On grant we
    // apply immediately via `mergeWorkspaceSourceEdges` (byte-identical to the
    // pre-governance path); the proposed branch returns the proposal and does
    // NOT apply — the `workspace/declare_source` executor materializes it on
    // approval.
    const { checkPermissionOrPropose, proposedMessageFor } =
      await import("../../../utils/permission-check.js");
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId: agentUserId ?? undefined,
      workspaceId,
      subjectType: "workspace",
      action: "declare_source",
      source: "api",
      data: {
        sourceRoles: parsed.data.sourceRoles,
        defaultSources: parsed.data.defaultSources,
      },
    });
    if ("denied" in perm && perm.denied) {
      return ok({ error: perm.reason });
    }
    if ("proposalId" in perm) {
      return ok({
        status: "proposed",
        message: proposedMessageFor(
          perm.proposalType,
          "Workspace edge declaration proposed for review (rewiring cross-workspace reads is governed) — it applies on approval."
        ),
        proposalId: perm.proposalId,
        summary: perm.summary,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
        workspaceId,
        ...(perm.deduped ? { deduped: true } : {}),
      });
    }
    // Granted (operator authority) → apply immediately. Attribute on the same
    // acting identity (agent when remapped, else operator).
    const actingUserId = agentUserId ?? userId;
    const result = await mergeWorkspaceSourceEdges(
      workspaceId,
      parsed.data,
      actingUserId
    );
    return ok({ status: "updated", workspaceId, ...result });
  },
  synap_create_project: async (
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
    // WRITE: confined/explicit lens or advisory focus only — never membership[0].
    const projectWsId = requestedWorkspaceId;
    if (!projectWsId) {
      return rejectMissingWriteWorkspace(userId);
    }
    const projectCtx = await createHubProtocolCallerContext(
      userId,
      apiKeyScopes,
      projectWsId,
      undefined,
      sessionId,
      agentUserId
    );
    const projectCaller = projectsRouter.createCaller(projectCtx);
    const result = await projectCaller.create({
      name: args.name as string,
      description: args.description as string | undefined,
      // Provenance: this create came through the MCP door.
      door: "mcp",
      // Gravity evidence — the tRPC create enforces ≥5 caller-visible ids for
      // agent callers (projectCtx carries the agent identity).
      evidenceEntityIds: Array.isArray(args.evidenceEntityIds)
        ? (args.evidenceEntityIds as string[])
        : undefined,
    });
    return ok(result);
  },
};
