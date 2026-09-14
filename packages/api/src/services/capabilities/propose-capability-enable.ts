/**
 * propose-capability-enable — the ONE answer to "this capability is installed
 * but not enabled", for every door that can hit it (founder decision D3,
 * 2026-09-14).
 *
 *   - AGENT caller  → ONE `capability.enable` proposal for the pack (deduped),
 *                     and a message saying the action did NOT run.
 *   - HUMAN caller  → no proposal; "Nothing ran" + the Settings pointer.
 *   - OWNER on behalf of an unattended run (a scheduled playbook) → the same
 *                     proposal, attributed to the owner, one open per pack.
 *   - NO ROW        → a door that gated a synthesized capability (no `tools` /
 *                     `skills` row) has nothing to enable; it says so instead of
 *                     claiming "installed".
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
 * It never enables anything. It files a `capability.enable` proposal; the
 * existing approve-executor (`routers/proposals/executors/capability.ts`) flips
 * the rows through `skills.setApproved` / `tools.setApproved`, which re-derive
 * the approver's authority (workspace owner / pod-admin) at approval time.
 *
 * ── WHY `createPendingProposal`, NOT `checkPermissionOrPropose` ──────────────
 * The gate ladder can answer `granted` for an agent (a governance rule, an
 * autoApproveFor lane), and a granted enable IS an auto-enable. This door must
 * ALWAYS propose, so it files directly — the same precedent as
 * `runMarketInstall` (an agent install always proposes).
 *
 * ── ONE REQUEST PER PACK ─────────────────────────────────────────────────────
 * The refused capability's container is resolved under the caller's lens
 * (`loadContainerRefs`) and the request covers every draft member of that pack
 * the caller can see. `data` carries ONLY the pack identity and its sorted draft
 * ids — never WHICH member was refused — so refusals on different members of one
 * pack land on the same pending request.
 *
 * Dedup: an agent row is deduped by the SSOT (`insertPendingProposal`'s
 * `computeProposalDedupHash`). The SSOT deliberately never dedups a HUMAN row (a
 * person may file the same change twice on purpose) — but an owner-attributed
 * request filed by a daily cron is not a person choosing twice, so that path
 * looks for an open request on the same pack first.
 */

import {
  db,
  skills,
  tools,
  proposals,
  and,
  eq,
  inArray,
  isNull,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { createLogger } from "@synap-core/core";
import {
  createPendingProposal,
  type CreatePendingProposalInput,
} from "../../utils/permission-check.js";
import { openLink } from "../../utils/deep-links.js";
import { getCapabilityMemberParts } from "../links/links-service.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

const logger = createLogger({ module: "propose-capability-enable" });

/** A skill or tool row. `kind` absent = skill (the execute door's shape). */
export interface CapabilityRef {
  kind?: "skill" | "tool";
  id: string;
  name: string;
}
/** Kept for the skill-only callers. */
export type SkillRef = CapabilityRef;

/** One enable request: a pack (or a lone, un-packaged row) and its draft members. */
export interface EnableRequestGroup {
  containerId: string | null;
  containerName: string | null;
  skills: CapabilityRef[];
}

/**
 * What the caller hands back. `originalActionRan: false` is a literal on BOTH
 * arms: the refused action did not run, whether or not the request was filed.
 */
export type CapabilityEnableOffer =
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl: string;
      title: string;
      skills: CapabilityRef[];
      originalActionRan: false;
      message: string;
    }
  | {
      status: "failed";
      error: string;
      originalActionRan: false;
      message: string;
    };

export const ENABLE_REQUESTED_NOT_RUN =
  "Nothing ran: this needs a capability that is installed but not enabled. A request to enable it is waiting for review — run the action again after it is approved.";

export const ENABLE_REQUEST_FAILED_NOT_RUN =
  "Nothing ran: this needs a capability that is installed but not enabled, and the request to enable it could not be filed. Ask the user to enable it (Settings → Capabilities).";

/** A human's refusal: nothing ran, and where they fix it. */
export function notEnabledHumanMessage(name: string): string {
  return `Nothing ran: "${name}" is installed but not enabled. Enable it in Settings → Capabilities, then run it again.`;
}

/** A synthesized capability (no row): there is nothing to enable. */
export function notInstalledMessage(name: string): string {
  return `Nothing ran: "${name}" has no installed capability on this pod that could be enabled. Ask the user to install or connect it (Settings → Capabilities).`;
}

const kindOf = (c: CapabilityRef) => c.kind ?? "skill";

/**
 * Pure: fold the refused rows and their packs' draft members into one request
 * per pack. A refused row is always in its own group, even when the member read
 * did not return it. A row in no container is its own group.
 */
export function planEnableRequests(input: {
  refused: CapabilityRef[];
  containerOf: Map<string, { id: string; name: string }>;
  draftMembersOf: Map<string, CapabilityRef[]>;
}): EnableRequestGroup[] {
  const groups = new Map<string, EnableRequestGroup>();
  for (const cap of input.refused) {
    const container = input.containerOf.get(cap.id);
    const key = container
      ? `capability:${container.id}`
      : `${kindOf(cap)}:${cap.id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        containerId: container?.id ?? null,
        containerName: container?.name ?? null,
        skills: container
          ? [...(input.draftMembersOf.get(container.id) ?? [])]
          : [],
      };
      groups.set(key, group);
    }
    if (!group.skills.some((s) => s.id === cap.id)) group.skills.push(cap);
  }
  for (const group of groups.values()) {
    group.skills.sort((a, b) => a.id.localeCompare(b.id));
  }
  return [...groups.values()];
}

/** The reviewer-facing title, from the vocabulary SSOT. */
export function enableRequestTitle(group: EnableRequestGroup): string {
  return buildObjectActionTitle({
    action: "enable",
    objectKind: "capability",
    objectName: group.containerName ?? group.skills[0]?.name ?? null,
  });
}

/**
 * Pure: the pending-proposal row for one group. `data` holds only what the
 * approval needs and what identifies the change — see the module note on dedup.
 */
export function buildEnableProposalInput(
  group: EnableRequestGroup,
  ctx: {
    userId: string;
    workspaceId: string | null;
    agentUserId: string | null;
    sessionId?: string | null;
  }
): CreatePendingProposalInput {
  const title = enableRequestTitle(group);
  const skillIds = group.skills
    .filter((s) => kindOf(s) === "skill")
    .map((s) => s.id);
  const toolIds = group.skills
    .filter((s) => kindOf(s) === "tool")
    .map((s) => s.id);
  return {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId,
    targetType: "capability",
    targetId: group.containerId ?? group.skills[0].id,
    proposalType: "capability.enable",
    sessionId: ctx.sessionId ?? null,
    data: {
      containerId: group.containerId,
      skillIds,
      // Only when present, so a skill-only pack's payload (and hash) is unchanged.
      ...(toolIds.length > 0 ? { toolIds } : {}),
      // Legacy single-skill field the executor still accepts; stable per group.
      ...(skillIds.length > 0 ? { skillId: skillIds[0] } : {}),
      // Volatile (stripped from the dedup hash): prose for the review queue.
      summary: `${title}: ${group.skills.map((s) => s.name).join(", ")}`,
      targetName: group.containerName ?? group.skills[0]?.name ?? null,
    },
    notificationDescription: title,
  };
}

/** An open owner-attributed request on the same pack (see the module note). */
async function findOpenOwnerRequest(
  input: CreatePendingProposalInput
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, input.proposalType),
        eq(proposals.targetType, input.targetType),
        eq(proposals.targetId, input.targetId),
        eq(proposals.status, ProposalStatus.PENDING),
        input.workspaceId
          ? eq(proposals.workspaceId, input.workspaceId)
          : isNull(proposals.workspaceId)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * File one enable request per pack for the refused rows. Never throws: a filing
 * failure comes back as a `failed` offer (the refusal must still reach the
 * caller, and a failed filing must not read as "nothing to enable").
 */
export async function proposeCapabilityEnable(input: {
  refused: CapabilityRef[];
  userId: string;
  workspaceId: string | null;
  /** The acting agent; `null` = filed on behalf of the owner (unattended run). */
  agentUserId: string | null;
  sessionId?: string | null;
}): Promise<CapabilityEnableOffer[]> {
  if (input.refused.length === 0) return [];
  try {
    const { loadContainerRefs, containerMemberKey } =
      await import("./capability-registry.js");
    const refusedSkills = input.refused.filter((c) => kindOf(c) === "skill");
    const refusedTools = input.refused.filter((c) => kindOf(c) === "tool");
    const refs = await loadContainerRefs({
      toolIds: refusedTools.map((c) => c.id),
      skillIds: refusedSkills.map((c) => c.id),
      userId: input.userId,
    });
    const containerOf = new Map<string, { id: string; name: string }>();
    for (const cap of input.refused) {
      const ref = refs.get(containerMemberKey(kindOf(cap), cap.id));
      if (ref) containerOf.set(cap.id, { id: ref.id, name: ref.name });
    }

    const containerIds = [
      ...new Set([...containerOf.values()].map((c) => c.id)),
    ];
    const parts = await getCapabilityMemberParts(containerIds);
    const skillPartIds = parts
      .filter((p) => p.kind === "skill")
      .map((p) => p.id);
    const toolPartIds = parts.filter((p) => p.kind === "tool").map((p) => p.id);
    const draftSkills =
      skillPartIds.length === 0
        ? []
        : await db
            .select({ id: skills.id, name: skills.name })
            .from(skills)
            .where(
              and(
                visibleSkillsWhere(
                  input.userId,
                  input.workspaceId ?? undefined
                ),
                eq(skills.status, "active"),
                eq(skills.approved, false),
                inArray(skills.id, skillPartIds)
              )
            );
    const draftTools =
      toolPartIds.length === 0
        ? []
        : await db
            .select({ id: tools.id, name: tools.name })
            .from(tools)
            .where(
              and(
                userVisibleWhere(tools.workspaceId, input.userId),
                eq(tools.approved, false),
                inArray(tools.id, toolPartIds)
              )
            );
    const draftById = new Map<string, CapabilityRef>([
      ...draftSkills.map(
        (r) =>
          [r.id, { kind: "skill" as const, id: r.id, name: r.name }] as const
      ),
      ...draftTools.map(
        (r) =>
          [r.id, { kind: "tool" as const, id: r.id, name: r.name }] as const
      ),
    ]);
    const draftMembersOf = new Map<string, CapabilityRef[]>();
    for (const part of parts) {
      const row = draftById.get(part.id);
      if (!row) continue;
      const list = draftMembersOf.get(part.capabilityId) ?? [];
      list.push(row);
      draftMembersOf.set(part.capabilityId, list);
    }

    const groups = planEnableRequests({
      refused: input.refused,
      containerOf,
      draftMembersOf,
    });
    const offers: CapabilityEnableOffer[] = [];
    for (const group of groups) {
      const pending = buildEnableProposalInput(group, input);
      // Deliberately NOT `checkPermissionOrPropose`: that ladder can answer
      // `granted` for an agent (a widening governance rule, autoApproveFor),
      // and a granted enable is an auto-enable. A PENDING proposal is the
      // governance here — mirrors `runMarketInstall` (an agent install always
      // proposes). `createPendingProposal` always inserts PENDING and dedups.
      const proposal =
        (input.agentUserId ? null : await findOpenOwnerRequest(pending)) ??
        (await createPendingProposal(pending));
      offers.push({
        status: "proposed",
        proposalId: proposal.id,
        reviewUrl: openLink(proposal.id),
        title: enableRequestTitle(group),
        skills: group.skills,
        originalActionRan: false,
        message: ENABLE_REQUESTED_NOT_RUN,
      });
    }
    return offers;
  } catch (err) {
    logger.warn(
      { err, ids: input.refused.map((s) => s.id) },
      "capability enable request could not be filed"
    );
    return [
      {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        originalActionRan: false,
        message: ENABLE_REQUEST_FAILED_NOT_RUN,
      },
    ];
  }
}

/**
 * The ONE refusal every gate door returns on a deny. A policy deny on an
 * enabled row passes its reason through untouched (enabling would not fix it).
 */
export async function resolveNotEnabledRefusal(input: {
  capability: CapabilityRef & { approved: boolean | null };
  /** `false` when the door gated a synthesized capability with no row. */
  installed: boolean;
  /** The gate's own deny reason. */
  reason: string;
  userId: string;
  workspaceId: string | null;
  agentUserId: string | null;
  sessionId?: string | null;
}): Promise<{ message: string; enableProposal?: CapabilityEnableOffer }> {
  if (!input.installed) {
    return { message: notInstalledMessage(input.capability.name) };
  }
  if (input.capability.approved !== false) return { message: input.reason };
  if (!input.agentUserId) {
    return { message: notEnabledHumanMessage(input.capability.name) };
  }
  const [offer] = await proposeCapabilityEnable({
    refused: [
      {
        kind: input.capability.kind,
        id: input.capability.id,
        name: input.capability.name,
      },
    ],
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentUserId: input.agentUserId,
    sessionId: input.sessionId ?? null,
  });
  return {
    message:
      offer.status === "proposed"
        ? `${offer.message} Review: ${offer.reviewUrl}`
        : offer.message,
    enableProposal: offer,
  };
}
