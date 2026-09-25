// ─── Helper functions to resolve commonly referenced names ───
//
// `stringProp` / `displayNameForUser` are the CANONICAL implementations —
// moved here (from `display.ts`, which used to define its own local copies)
// so this module can use them without a circular import back to `display.ts`
// (`display.ts` imports `createNameResolvers` from here). `display.ts`
// re-exports both from this file so every existing external import site
// (`routers/proposals.ts`, `services/focus-sessions/participants.ts`) is
// unaffected.
import { isLikelyUUID } from "@synap-core/types/proposals";

export function stringProp(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function displayNameForUser(row: {
  name: string | null;
  email: string;
  userType: string;
  agentMetadata: { agentType?: string; description?: string } | null;
}): string | undefined {
  if (row.name) return row.name;
  if (row.userType === "agent") {
    return row.agentMetadata?.agentType ?? row.agentMetadata?.description;
  }
  return row.email || undefined;
}

// ProposalRow type - minimal shape needed by resolvers.
//
// `targetType` (the `proposals.target_type` column, e.g. "focus_session",
// "playbook", "project", "automation", "workspace") is the discriminator a
// resolver must gate on — NOT `proposalType`. `checkPermissionOrPropose`
// stores the BARE ACTION VERB ("create" / "update" / "run" / …) in the
// `proposal_type` column (`permission-check.ts` `createPendingProposalRow`:
// `proposalType: action`); the `${subjectType}.${action}` dotted string is
// only the shape returned in the CALL RESULT for logging/display, never what
// lands in the row. So `row.proposalType.startsWith("session/")` (the old
// guard here) matches NOTHING a real session/playbook/project/automation/
// workspace proposal ever carries — those filters were dead code. The two
// exceptions are `capability.run` (`CAPABILITY_RUN_PROPOSAL_TYPE`) and every
// `governance.*` type, which ARE written as literal dotted strings directly
// (not through the subjectType/action door), so those two gates are correct
// as `proposalType` checks.
type ProposalRow = {
  proposalType: string;
  targetType: string;
  agentUserId?: string | null;
  targetId?: string;
  workspaceId?: string | null;
  subjectUserId?: string | null;
  /** The `proposals.project_id` column — set directly by `checkPermissionOrPropose`
   * (`projectId` arg), never carried in `data`. */
  projectId?: string | null;
  /** The `proposals.thread_id` column — the channel the proposal was filed
   * from. The frontend reads it as `originChannelId`. */
  threadId?: string | null;
};

/**
 * The ids a proposal row references BY NAME, one per name-bearing table —
 * the ONE derivation both the batch collection in `enrichProposalsForDisplay`
 * and the resolvers below read. Before this existed the collection filtered on
 * `proposalType.startsWith("session/")`-style prefixes while the resolvers
 * gated on `targetType`, so an id the resolver asked for was never fetched.
 * Only uuid-shaped ids are returned (the batch reads bind `uuid` columns).
 */
export interface ReferencedNameIds {
  playbook?: string;
  project?: string;
  automation?: string;
  workspace?: string;
  channel?: string;
  originChannel?: string;
  skill?: string;
  tool?: string;
}

const uuidOrUndefined = (value: string | null | undefined) =>
  value && isLikelyUUID(value) ? value : undefined;

export function referencedNameIds(
  row: ProposalRow,
  payload: Record<string, unknown> | undefined
): ReferencedNameIds {
  const ids: ReferencedNameIds = {};
  if (row.targetType === "focus_session") {
    ids.playbook = uuidOrUndefined(
      stringProp(payload, "playbookId") ?? stringProp(payload, "templateId")
    );
  }
  ids.project = uuidOrUndefined(row.projectId);
  if (row.targetType === "automation") {
    ids.automation = uuidOrUndefined(stringProp(payload, "automationId"));
  }
  // Literal, written directly by every producer via
  // `CAPABILITY_RUN_PROPOSAL_TYPE` — not the `${subjectType}.${action}`
  // shape, so this IS the correct discriminator (confirmed in
  // `services/proposals/proposal-class.ts`).
  if (row.proposalType === "capability.run") {
    ids.skill = uuidOrUndefined(
      stringProp(payload, "capabilityId") ?? stringProp(payload, "skillId")
    );
    ids.tool = uuidOrUndefined(stringProp(payload, "toolId"));
  }
  if (row.targetType === "workspace") {
    ids.workspace = uuidOrUndefined(
      stringProp(payload, "workspaceId") ?? row.targetId
    );
  }
  // Literal, same as `capability.run` above — `governance.*` proposal types
  // are written directly, not through the subjectType/action door.
  if (row.proposalType === "governance.tighten_posture") {
    ids.channel = uuidOrUndefined(stringProp(payload, "channelId"));
  }
  ids.originChannel = uuidOrUndefined(row.threadId);
  return ids;
}

export interface NameResolutionContext {
  playbookById: Map<string, { name: string; goalTemplate: string }>;
  projectById: Map<string, { name: string; description: string | undefined }>;
  automationById: Map<string, { name: string }>;
  skillById: Map<string, { name: string; slug: string }>;
  toolById: Map<string, { name: string }>;
  workspaceById: Map<string, { name: string }>;
  channelById: Map<string, { title: string | undefined }>;
  userById: Map<
    string,
    {
      id: string;
      name: string | null;
      email: string;
      userType: string;
      agentMetadata: unknown;
      createdByUserId: string | null;
    }
  >;
}

/**
 * A `/links`-door proposal's endpoint pair — `POST /links` (rest/links.ts) and
 * MCP `synap_project_use_workspace` both file `checkPermissionOrPropose({
 * subjectType: "link", data: { title, fromType, fromId, toType, toId,
 * linkType } })`, and `createPendingProposalRow` stamps `targetType: "link"`
 * for that subjectType — never a `proposalType` prefix (see the file-level
 * comment above: `proposalType` stores the bare verb). Detected by PAYLOAD
 * SHAPE, matching that convention.
 */
export interface LinkEndpointPair {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
}

export function linkEndpointsFromPayload(
  row: { targetType: string },
  payload: Record<string, unknown> | undefined
): LinkEndpointPair | undefined {
  if (row.targetType !== "link") return undefined;
  const fromType = stringProp(payload, "fromType");
  const fromId = stringProp(payload, "fromId");
  const toType = stringProp(payload, "toType");
  const toId = stringProp(payload, "toId");
  if (!fromType || !fromId || !toType || !toId) return undefined;
  return { fromType, fromId, toType, toId };
}

/**
 * Batch-joined lookups a `/links`-door endpoint's display name can come from,
 * one per `LINK_ENDPOINT_TYPES` member this door can currently resolve.
 * `resolveEntityTitle` is passed in rather than a raw map because entity
 * endpoints must go through the SAME workspace-lens-scoped resolver the
 * relation-endpoint path uses (`resolveEntityTitleScoped` in display.ts) —
 * never an unscoped read, since a link can point at an entity outside the
 * proposal's own workspace.
 */
export interface LinkEndpointNameContext {
  resolveEntityTitle: (entityId: string) => string | undefined;
  /** Session TITLES, already floored by `ownerPrivateVisibleWhere` at the
   * batch query that built this map (see `sessionGoalById` in display.ts). */
  sessionTitleById: Map<string, string>;
  playbookById: Map<string, { name: string }>;
  projectById: Map<string, { name: string }>;
  automationById: Map<string, { name: string }>;
  workspaceById: Map<string, { name: string }>;
  channelById: Map<string, { title: string | undefined }>;
  toolById: Map<string, { name: string }>;
  skillById: Map<string, { name: string }>;
  /** Document titles, already floored by `ownerPrivateVisibleWhere`. */
  documentTitleById: Map<string, string>;
  /** `agents` REGISTRY names, already floored by `visibleAgentsWhere` (shared
   * built-ins + the viewer's own adjuncts). An "agent" endpoint id is an
   * `agents.id`, never a `users.id` — resolving it against users was an
   * unfloored name/email oracle for any user id. */
  agentById: Map<string, { name: string }>;
}

/**
 * Resolve one `/links`-door endpoint (type + id) to a display name.
 *
 * `command` / `source` / `participant` / `secret` have no name-bearing table
 * wired here — they return `undefined`, never a fabricated label from the id.
 * `capability` tries `skillById` then `toolById`, mirroring
 * `resolveCapabilityCallLabel`'s own skill-first-then-tool fallback above.
 */
export function resolveLinkEndpointName(
  type: string,
  id: string,
  ctx: LinkEndpointNameContext
): string | undefined {
  switch (type) {
    case "entity":
      return ctx.resolveEntityTitle(id);
    case "session":
      return ctx.sessionTitleById.get(id);
    case "playbook":
      return ctx.playbookById.get(id)?.name;
    case "project":
      return ctx.projectById.get(id)?.name;
    case "automation":
      return ctx.automationById.get(id)?.name;
    case "workspace":
      return ctx.workspaceById.get(id)?.name;
    case "channel":
      return ctx.channelById.get(id)?.title;
    case "tool":
      return ctx.toolById.get(id)?.name;
    case "skill":
      return ctx.skillById.get(id)?.name;
    case "capability":
      return ctx.skillById.get(id)?.name ?? ctx.toolById.get(id)?.name;
    case "document":
      return ctx.documentTitleById.get(id);
    case "agent":
      return ctx.agentById.get(id)?.name;
    default:
      return undefined;
  }
}

export function createNameResolvers(ctx: NameResolutionContext) {
  return {
    resolvePlaybookName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const playbookId = referencedNameIds(row, payload).playbook;
      return playbookId ? ctx.playbookById.get(playbookId)?.name : undefined;
    },

    resolveProjectName(row: ProposalRow): string | undefined {
      // `projectId` is a real column on `proposals` (the producing session's
      // project), set for any proposal kind — not something to derive from a
      // payload field or a proposalType prefix.
      const projectId = referencedNameIds(row, undefined).project;
      return projectId ? ctx.projectById.get(projectId)?.name : undefined;
    },

    resolveAutomationName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const automationId = referencedNameIds(row, payload).automation;
      return automationId
        ? ctx.automationById.get(automationId)?.name
        : undefined;
    },

    resolveCapabilityCallLabel(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      // Literal, written directly by every producer via
      // `CAPABILITY_RUN_PROPOSAL_TYPE` — not the `${subjectType}.${action}`
      // shape, so this IS the correct discriminator (confirmed in
      // `services/proposals/proposal-class.ts`).
      const pt = row.proposalType;
      if (pt === "capability.run") {
        const { skill: capabilityId, tool: toolId } = referencedNameIds(
          row,
          payload
        );
        const provider = stringProp(payload, "provider");
        const verb =
          stringProp(payload, "verb") ??
          stringProp(payload, "verbName") ??
          stringProp(payload, "verbId");
        const path = stringProp(payload, "path");

        // Try skills first
        if (capabilityId) {
          const skill = ctx.skillById.get(capabilityId);
          if (skill) {
            return `${skill.name}${verb ? ` · ${verb}` : ""}`;
          }
        }
        // Try tools
        if (toolId) {
          const tool = ctx.toolById.get(toolId);
          if (tool) {
            return `${tool.name}${path ? ` ${path}` : ""}${verb ? ` · ${verb}` : ""}`;
          }
        }
        // Fallback to provider + verb/path
        if (provider && (verb || path)) {
          return `${provider} ${verb ?? path ?? ""}`.trim();
        }
        if (provider) return provider;
      }
      return undefined;
    },

    resolveWorkspaceName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const workspaceId = referencedNameIds(row, payload).workspace;
      return workspaceId ? ctx.workspaceById.get(workspaceId)?.name : undefined;
    },

    resolveChannelName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const channelId = referencedNameIds(row, payload).channel;
      return channelId ? ctx.channelById.get(channelId)?.title : undefined;
    },

    /** The channel the proposal was filed from (`proposals.thread_id`),
     * exposed as `originChannelName` beside the frontend's `originChannelId`. */
    resolveOriginChannelName(row: ProposalRow): string | undefined {
      const channelId = referencedNameIds(row, undefined).originChannel;
      return channelId ? ctx.channelById.get(channelId)?.title : undefined;
    },

    resolveAgentName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      // For governance proposals, resolve the agent name
      const pt = row.proposalType;
      if (pt.startsWith("governance.")) {
        const agentId = row.agentUserId ?? stringProp(payload, "agentId");
        if (agentId && isLikelyUUID(agentId)) {
          // The agent row is already in userById (we joined all users)
          const agentRow = ctx.userById.get(agentId);
          if (agentRow) {
            // `NameResolutionContext.userById` types `agentMetadata` as
            // `unknown` (it is whatever shape the caller's batch-joined user
            // rows carry); `displayNameForUser`'s canonical signature narrows
            // it to the agent-metadata shape it actually reads.
            return displayNameForUser(
              agentRow as unknown as Parameters<typeof displayNameForUser>[0]
            );
          }
        }
      }
      return undefined;
    },
  };
}
