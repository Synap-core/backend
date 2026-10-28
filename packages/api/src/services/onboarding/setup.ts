/**
 * The onboarding setup (plan v1 §2.4, slice A6): the start the person chose
 * arrives as ONE proposal from their own agent, and an approved setup can be
 * undone.
 *
 * No second install path. `proposeSetup` files through the ONE filing door
 * the Hub `/packages/apply` uses (`proposeTemplateApply`), authored by the
 * person's personal agent (`ensurePersonalAgentUser`): an agent's
 * `workspace/create` is floored to a proposal (governance rung 2.09), and
 * approving it runs the one template apply as the approver — the template's
 * space AND its required dependencies (CRM → Foundation), in one approval.
 * A person's own install would execute directly; the setup is the first
 * thing the person approves (D6), so the agent authors it.
 *
 * Idempotency is DERIVED from the proposal rows, not trusted from journey
 * values: a pending setup filed by this person's agent is handed back.
 */
import { TRPCError } from "@trpc/server";
import { and, db, desc, drizzleSql, eq, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { ensurePersonalAgentUser } from "../../utils/personal-agent-user.js";
import { resolveWorkspaceTemplate } from "../capabilities/resolve-workspace-template.js";
import {
  admitTemplateApply,
  proposeTemplateApply,
} from "../template-apply/propose.js";

/** The filing door's name on the proposal (`data.via`). */
export const ONBOARDING_SETUP_VIA = "onboarding.start";

export interface ProposeSetupResult {
  proposalId: string;
  /** True when a pending setup already existed and was handed back. */
  reused: boolean;
}

/** The latest setup proposal this person's agent filed, in one status. */
async function findSetupProposal(
  agentUserId: string,
  status: "pending" | "approved"
): Promise<{ id: string; data: unknown } | null> {
  const [row] = await db
    .select({ id: proposals.id, data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.agentUserId, agentUserId),
        eq(
          proposals.status,
          status === "pending"
            ? ProposalStatus.PENDING
            : ProposalStatus.APPROVED
        ),
        eq(proposals.targetType, "workspace"),
        drizzleSql`${proposals.data}->'data'->>'via' = ${ONBOARDING_SETUP_VIA}`
      )
    )
    .orderBy(desc(proposals.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Mark the chosen view the space opens on: `defaultView` true on it, false on
 * every other view (the create core lands the flag in the view's config,
 * where `config` wins — so it is set there too when the view has one).
 */
function withDefaultView(
  definition: Record<string, unknown>,
  chosen: { profile: string; view: string }
): Record<string, unknown> {
  const views = Array.isArray(definition.views)
    ? (definition.views as Array<Record<string, unknown>>)
    : [];
  const match = views.find(
    (v) => v.slug === chosen.view && v.scopeProfileSlug === chosen.profile
  );
  if (!match) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This template has no view "${chosen.view}" of ${chosen.profile}.`,
    });
  }
  return {
    ...definition,
    views: views.map((v) => {
      const isDefault = v === match;
      const config =
        v.config && typeof v.config === "object"
          ? { config: { ...(v.config as object), defaultView: isDefault } }
          : {};
      return { ...v, defaultView: isDefault, ...config };
    }),
  };
}

export async function proposeSetup(input: {
  userId: string;
  slug: string;
  view?: { profile: string; view: string };
}): Promise<ProposeSetupResult> {
  const { userId } = input;
  const agentUserId = await ensurePersonalAgentUser(userId);

  const pending = await findSetupProposal(agentUserId, "pending");
  if (pending) return { proposalId: pending.id, reused: true };

  const slug = input.slug.trim();
  const resolved = await resolveWorkspaceTemplate(slug);
  if (!resolved) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No template "${slug}" in this pod's catalog.`,
    });
  }
  let definition: Record<string, unknown> = {
    ...(resolved.packageDefinition as unknown as Record<string, unknown>),
    _meta: {
      ...(resolved.packageDefinition._meta ?? {}),
      slug,
      ...(resolved.version ? { version: resolved.version } : {}),
    },
  };
  if (input.view) definition = withDefaultView(definition, input.view);

  const { PackageApplySchema } =
    await import("../../routers/hub-protocol/rest/packages.js");
  const body = PackageApplySchema.parse(definition);

  const admission = await admitTemplateApply({ userId, body });
  if (!admission.ok) {
    throw new TRPCError(
      admission.refusal === "one-space-per-domain"
        ? { code: "CONFLICT", message: admission.reply.guidance }
        : {
            code: "PRECONDITION_FAILED",
            message: `This template would not apply cleanly on this pod: ${
              admission.preflight.validationErrors.join("; ") ||
              "it conflicts with the pod's catalog"
            }`,
          }
    );
  }

  const filed = await proposeTemplateApply({
    userId,
    agentUserId,
    body,
    via: ONBOARDING_SETUP_VIA,
  });
  if (filed.kind === "denied")
    throw new TRPCError({ code: "FORBIDDEN", message: filed.reason });
  if (filed.kind === "granted") {
    // Unreachable while `workspace/create` is floored for agents: the setup
    // is never installed without the person's approval.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "The setup was not filed for your approval, so nothing was set up.",
    });
  }
  return { proposalId: filed.proposalId, reused: false };
}

/** The spaces an approved template proposal minted (`markApproved` stamps them). */
export function createdSpaceIds(data: unknown): string[] {
  const ids = (data as { createdWorkspaceIds?: unknown } | null)
    ?.createdWorkspaceIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}

export interface UndoSetupResult {
  proposalId: string;
  spaces: Array<{
    workspaceId: string;
    status: "archived" | "proposed";
    proposalId?: string;
  }>;
}

/**
 * Archive every space the latest approved setup created, through the
 * person's own `workspaces.archive` door (`archive`): it pauses their
 * automations and can be restored. The kinds the setup added stay.
 * `proposals.revert` cannot do this — it undoes entities, relations and
 * documents only.
 */
export async function undoSetup(input: {
  userId: string;
  archive: (
    workspaceId: string
  ) => Promise<{ status: string; proposalId?: string }>;
}): Promise<UndoSetupResult> {
  const agentUserId = await ensurePersonalAgentUser(input.userId);
  const approved = await findSetupProposal(agentUserId, "approved");
  if (!approved) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "There is no approved setup to undo.",
    });
  }
  const spaces: UndoSetupResult["spaces"] = [];
  for (const workspaceId of createdSpaceIds(approved.data)) {
    const done = await input.archive(workspaceId);
    spaces.push(
      done.status === "proposed"
        ? { workspaceId, status: "proposed", proposalId: done.proposalId }
        : { workspaceId, status: "archived" }
    );
  }
  return { proposalId: approved.id, spaces };
}
