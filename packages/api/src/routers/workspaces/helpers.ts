/**
 * Workspaces router — shared helpers used across the CRUD, invites,
 * definition-engine, and mcp-servers clusters. Moved verbatim out of
 * `workspaces.ts` during router-decomposition Wave 6 — no logic changed.
 */

import { config, createLogger } from "@synap-core/core";
import { podCpAuthHeaders } from "@synap/database";
import type { PackagePostWorkspaceBody } from "../../services/package-apply-post-workspace.js";
import type { LoopDefinition, LoopPlaybookDef } from "@synap/playbooks";
import type { PlaybookDefinition } from "../../schemas/playbook-definition.js";

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
  /**
   * The parsed ONE playbook definition (schemas/playbook-definition.ts) plus
   * this door's grant shape. Typed off the schema, never a hand-listed field
   * set — the hand list is what dropped `scope` / `stages` / `criteria` /
   * `metadata` before the body builder could forward them.
   */
  playbooks?: Array<
    Omit<Partial<PlaybookDefinition>, "grants"> & {
      name: string;
      /**
       * Authored either as bare NAMES (the Hub door's form, what templates write)
       * or as `{kind, ref}` objects. Only the object form carries a resolvable id
       * for the loop applier — see the narrowing in the body builder.
       */
      grants?: Array<string | { kind: string; ref: string }>;
    }
  >;
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
  /** Template rules — forwarded verbatim; `applyTemplateRules` parses them. */
  rules?: PackagePostWorkspaceBody["rules"];
  /**
   * Declared skills — forwarded verbatim; `applyTemplateSkills` parses them and
   * links each to the space's brief (approved ones only).
   */
  skills?: PackagePostWorkspaceBody["skills"];
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
        // SPREAD the whole parsed definition, then override only what the loop
        // shape needs. A fixed field list here is what silently dropped
        // `scope` / `stages` / `criteria` / `metadata` (grants.yaml's 6-step
        // project method reached the loop applier as a stageless session).
        playbooks: (playbookDefs ?? []).map((pb) => ({
          ...pb,
          ref: pb.name,
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
    rules: definition.rules,
    skills: definition.skills,
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

/**
 * The pod's own name, when the deploy set one — sent only as a CLAIM. The CP
 * identifies a pod-signed caller by its key, so a pod with no name (every
 * installer-built pod: neither env var is set) is still recognised; only a
 * legacy shared-key pod needs the name for the CP to know who it is.
 */
function podSubdomainClaim(): { podSubdomain?: string } {
  const name =
    process.env.POD_SUBDOMAIN?.trim() || process.env.SERVER_DOMAIN?.trim();
  return name ? { podSubdomain: name } : {};
}

/**
 * POST an invite record to the CP's `/internal/*`, authenticated by the pod's
 * one pod→CP credential door. No credential (a self-hosted pod) = not sent.
 * A non-2xx answer THROWS, so the caller's `.catch` logs a refused sync
 * instead of reading it as a recorded one.
 */
async function sendToCp(cpUrl: string, path: string, body: unknown) {
  const auth = await podCpAuthHeaders({
    purpose: "invites",
    legacy: "internal-key",
    controlPlaneUrl: cpUrl,
  });
  if (!auth) return;
  const res = await fetch(`${cpUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth.headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Control Plane ${path} answered ${res.status}: ${await cpErrorText(res)}`
    );
  }
}

/** The `{error}` / `{reason}` a CP answer carries, else its status text. */
async function cpErrorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; reason?: unknown };
    const message = parsed.error ?? parsed.reason;
    if (typeof message === "string" && message) return message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text.slice(0, 200) || res.statusText || "no detail";
}

export type CpInviteEmailResult =
  { sent: true } | { sent: false; reason: string };

/**
 * Ask the CP to email an invite, and report what actually happened. A
 * refusal (non-2xx), a skipped send (`{sent:false, reason}` — e.g. no active
 * subscription) and an unreachable CP are each `sent: false` WITH the reason,
 * so the inviter learns the email did not go. Never throws: the invite row
 * already exists and its link still works.
 */
export async function sendCpInviteEmail(
  cpUrl: string,
  body: Record<string, string>
): Promise<CpInviteEmailResult> {
  try {
    const auth = await podCpAuthHeaders({
      purpose: "invites",
      legacy: "internal-key",
      controlPlaneUrl: cpUrl,
    });
    if (!auth) {
      return {
        sent: false,
        reason:
          "This pod holds no Control Plane credential, so no invite email was sent.",
      };
    }
    const res = await fetch(`${cpUrl}/internal/invite-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify({ ...body, ...podSubdomainClaim() }),
    });
    if (!res.ok) {
      const reason = `The Control Plane refused the invite email (${res.status}): ${await cpErrorText(res)}`;
      logger.warn({ status: res.status, reason }, "Invite email not sent");
      return { sent: false, reason };
    }
    const answer = (await res.json().catch(() => null)) as {
      sent?: unknown;
      reason?: unknown;
    } | null;
    if (answer?.sent === true) return { sent: true };
    const reason =
      typeof answer?.reason === "string" && answer.reason
        ? answer.reason
        : "The Control Plane did not send the invite email.";
    logger.warn({ reason }, "Invite email not sent");
    return { sent: false, reason };
  } catch (err) {
    logger.warn({ err }, "Invite email not sent: Control Plane unreachable");
    return {
      sent: false,
      reason: `The Control Plane could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
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
  if (!cpUrl) return;
  const backendOrigin =
    process.env.PUBLIC_BACKEND_URL || process.env.SYNAP_INSTANCE_URL;
  const body = {
    ...podSubdomainClaim(),
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
  sendToCp(cpUrl, "/internal/invites/sync", body).catch((err) =>
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
  if (!cpUrl) return;
  const body = {
    ...podSubdomainClaim(),
    inviteToken: input.inviteToken,
    event: input.event,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };
  sendToCp(cpUrl, "/internal/invites/lifecycle", body).catch((err) =>
    logger.warn({ err }, "Failed to sync invite lifecycle to control plane")
  );
}
