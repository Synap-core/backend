/**
 * Workspaces router — shared helpers used across the CRUD, invites,
 * definition-engine, and mcp-servers clusters. Moved verbatim out of
 * `workspaces.ts` during router-decomposition Wave 6 — no logic changed.
 */

import { config, createLogger } from "@synap-core/core";
import type { PackagePostWorkspaceBody } from "../../services/package-apply-post-workspace.js";
import type { LoopDefinition, LoopPlaybookDef } from "@synap/playbooks";

export const logger: ReturnType<typeof createLogger> = createLogger({
  module: "workspaces",
});

/**
 * The `definition` fields the post-workspace body-builder reads. A structural
 * slice of `createFromDefinition`'s zod input — the two disagreed silently
 * before: `definition.automations` here is the LOOP-style
 * `{trigger, action:{playbookSlug}}` shape (materialized as a loop TRIGGER),
 * NOT the graph-flow `PackagePostWorkspaceBody['automations']`
 * (`{triggerType, flowDefinition}`). The compose-overlay caller used to
 * `input.definition as unknown as PackagePostWorkspaceBody`, which fed loop-style
 * automations into the graph-automation applier step → every one threw
 * (undefined `triggerType`) and was silently swallowed. Building the body HERE,
 * the same way the normal-create branch does, is the one door both use.
 */
export interface CreateDefinitionPostWorkspaceSlice {
  playbooks?: Array<{
    name: string;
    goalTemplate?: string;
    description?: string;
    params?: unknown;
    executor?: LoopPlaybookDef["executor"];
    expectedOutputs?: unknown;
    subjectProfile?: LoopPlaybookDef["subjectProfile"];
    /** Scheduled cadence (e.g. a radar's weekly scan) — forwarded to the loop applier. */
    schedule?: LoopPlaybookDef["schedule"];
    /**
     * Authored either as bare NAMES (the Hub door's form, what templates write)
     * or as `{kind, ref}` objects. Only the object form carries a resolvable id
     * for the loop applier — see the narrowing in the body builder.
     */
    grants?: Array<string | { kind: string; ref: string }>;
  }>;
  automations?: Array<{
    name: string;
    description?: string;
    trigger: {
      type: "cron" | "event" | "manual";
      cron?: string;
      eventType?: string;
    };
    action: {
      type: "playbook_run";
      playbookSlug: string;
      params?: Record<string, unknown>;
    };
  }>;
  /**
   * Graph-flow automations from workspace templates. This stays separate from
   * `automations` above: that historical field represents LOOP playbook
   * triggers and has a different wire contract.
   */
  flowAutomations?: PackagePostWorkspaceBody["automations"];
  capabilities?: PackagePostWorkspaceBody["capabilities"];
  actionPlacements?: PackagePostWorkspaceBody["actionPlacements"];
}

/**
 * Build the shared `applyPackagePostWorkspace` body from a
 * `createFromDefinition` definition: capabilities install alongside a single
 * autonomy `loops[]` entry carrying playbooks + their loop-style automation
 * triggers, plus `actionPlacements` merged into settings. Used by BOTH the
 * normal-create and compose-overlay branches so a loop-style definition can
 * never be misrouted into the graph-automation applier step.
 */
export function buildPostWorkspaceBodyFromDefinition(
  definition: CreateDefinitionPostWorkspaceSlice,
  targetWorkspaceId: string
): PackagePostWorkspaceBody {
  const playbookDefs = definition.playbooks;
  const automationDefs = definition.automations;
  const hasLoop =
    (playbookDefs && playbookDefs.length > 0) ||
    (automationDefs && automationDefs.length > 0);
  const loopDef: LoopDefinition | undefined = hasLoop
    ? {
        key: `workspace-${targetWorkspaceId}`,
        name: "Workspace loop",
        // Loop playbook defs are "stored loosely, validated at the boundary"
        // (see LoopPlaybookDef) — cast the mapped array once rather than field
        // by field. Mirrors the pre-extraction inline literal's contextual typing.
        playbooks: (playbookDefs ?? []).map((pb) => ({
          ref: pb.name,
          name: pb.name,
          goalTemplate: pb.goalTemplate,
          description: pb.description,
          params: pb.params,
          executor: pb.executor,
          expectedOutputs: pb.expectedOutputs,
          // Carry the subject kind → `createLoopFromDefinition` forwards it to
          // `playbooksRouter.create`, landing on `subject_profile`.
          subjectProfile: pb.subjectProfile,
          // Carry the schedule through — `LoopPlaybookDef` and the loop applier
          // both support it, and without it a template-authored radar cadence
          // (`schedule: {cron, enabled:false}`) is silently dropped on this door.
          schedule: pb.schedule,
          // Grants may be authored as bare NAMES (the Hub door's form) or as
          // `{kind, ref}`. The loop applier writes `toId: g.id` straight into a
          // link row, so it needs a real row id — a NAME cannot be resolved
          // here (this is a pure function with no db). Objects pass through;
          // names are left to the Hub / approve-executor door, which resolves
          // them properly via `resolveGrantRefs`. Dropping them here keeps the
          // install succeeding instead of writing link rows pointing at a name.
          grants: pb.grants
            ?.filter(
              (g): g is { kind: "tool" | "skill" | "command"; ref: string } =>
                typeof g !== "string"
            )
            .map((g) => ({ kind: g.kind, id: g.ref })),
        })) as unknown as LoopPlaybookDef[],
        triggers: (automationDefs ?? []).map((auto) => ({
          name: auto.name,
          description: auto.description,
          trigger: {
            type: auto.trigger.type,
            cron: auto.trigger.cron,
            eventType: auto.trigger.eventType,
          },
          playbookRef: auto.action.playbookSlug,
          params: auto.action.params,
        })),
      }
    : undefined;
  return {
    automations: definition.flowAutomations,
    capabilities: definition.capabilities,
    loops: loopDef
      ? [{ definition: loopDef as unknown as Record<string, unknown> }]
      : undefined,
    actionPlacements: definition.actionPlacements,
  };
}

function getWorkspaceVisibility(settings: unknown): string {
  if (!settings || typeof settings !== "object") return "members";
  const visibility = (settings as Record<string, unknown>).workspaceVisibility;
  return typeof visibility === "string" ? visibility : "members";
}

/**
 * The pod-visibility gate for admin materialization. Exported so the
 * materialization tripwire can assert the EXACT predicate the create /
 * createFromDefinition / updateMemberRole triggers use to decide whether to
 * materialize pod admins — `true` ONLY for pod_visible / pod_joinable, so a
 * private workspace is never widened.
 */
export function isPodReadableWorkspace(settings: unknown): boolean {
  const visibility = getWorkspaceVisibility(settings);
  return visibility === "pod_visible" || visibility === "pod_joinable";
}

export async function notifyCpInviteSync(input: {
  type: "workspace" | "pod";
  inviteToken: string;
  email: string;
  role: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  invitedByUserId?: string | null;
  expiresAt: Date;
}) {
  const cpUrl = config.server.controlPlaneUrl;
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const podSubdomain =
    process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
  if (!cpUrl || !internalKey || !podSubdomain) return;
  const backendOrigin =
    process.env.PUBLIC_BACKEND_URL || process.env.SYNAP_INSTANCE_URL;
  const body = {
    podSubdomain,
    inviteToken: input.inviteToken,
    type: input.type,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    email: input.email,
    role: input.role,
    invitedByUserId: input.invitedByUserId ?? null,
    backendOrigin,
    expiresAt: input.expiresAt.toISOString(),
  };
  fetch(`${cpUrl}/internal/invites/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": internalKey,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    logger.warn({ err }, "Failed to sync invite to control plane")
  );
}

export async function notifyCpInviteLifecycle(input: {
  inviteToken: string;
  event: "accepted" | "rejected" | "revoked" | "expired";
  actorEmail?: string;
  actorUserId?: string;
  reason?: string;
}) {
  const cpUrl = config.server.controlPlaneUrl;
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const podSubdomain =
    process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
  if (!cpUrl || !internalKey || !podSubdomain) return;
  const body = {
    podSubdomain,
    inviteToken: input.inviteToken,
    event: input.event,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };
  fetch(`${cpUrl}/internal/invites/lifecycle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": internalKey,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    logger.warn({ err }, "Failed to sync invite lifecycle to control plane")
  );
}
