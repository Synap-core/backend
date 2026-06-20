/**
 * Playbook lifecycle — instantiate (config → runtime) and promote (runtime → config).
 *
 * - instantiateSession: turn a Playbook (template) into a runtime focus_session.
 *   Resolves the goalTemplate against caller params, copies expectedOutputs, and
 *   writes the `session → instantiated_from → playbook` edge. The channel is left
 *   null (wired on run start by the executor, P3), matching focus_sessions
 *   semantics. The run's granted capabilities are read from the playbook's
 *   `grants` links at run time — not copied here.
 * - promoteSessionToPlaybook: snapshot a validated session into a reusable
 *   Playbook. Captures goal + expectedOutputs and re-grants the capabilities the
 *   session USED (its `used` links) as the new playbook's `grants` links; writes
 *   the `session → promoted_to → playbook` lineage edge.
 *
 * GOVERNANCE: these are pure domain operations — the caller (tRPC router / Hub
 * REST) MUST run `checkPermissionOrPropose` before invoking them. The link
 * writes here are side effects of an already-gated mutation, so they ride the
 * parent's approval (the bare links-service write path stays caller-gated).
 *
 * Part of the Playbooks & Capability Substrate
 * (team/platform/playbooks-capability-substrate.mdx).
 */

import { getDb, eq, focusSessions, playbooks } from "@synap/database";
import type { Playbook, FocusSession } from "@synap/database/schema";
import type { ExpectedOutput, LinkInput } from "@synap/playbooks";
import { parseCommandTemplate } from "../../utils/command-template.js";
import {
  createLinks,
  extractCapabilities,
  getLinksFor,
} from "../links/links-service.js";

/** Resolve a playbook's goalTemplate against caller-supplied param values. */
function resolveGoal(
  goalTemplate: string,
  params: Record<string, unknown>
): string {
  const argValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    argValues[k] = v == null ? "" : String(v);
  }
  return parseCommandTemplate(goalTemplate).substitute(argValues);
}

export interface InstantiateInput {
  playbookId: string;
  /** The workspace the session runs in (verified membership upstream). */
  workspaceId: string;
  /** The human/agent starting the run. */
  userId: string;
  params?: Record<string, unknown>;
  channelId?: string | null;
  agentIds?: string[];
  /**
   * Project this session is scoped to (project-centric-scope Phase 4).
   * When provided, the session is anchored to a project (entity with
   * profileSlug='project') and a `session --targets--> project` link is
   * written. workspaceId is still required for the channel / workspace
   * membership context even when projectId is set.
   */
  projectId?: string | null;
  /**
   * The entity this session is about (e.g. a contact, deal, or document).
   * Stored as focus_sessions.subjectEntityId — threads RunContext.subjectId
   * through from the playbook run input.
   */
  subjectId?: string | null;
}

/**
 * Instantiate a runtime focus_session from a playbook. Caller MUST gate first.
 */
export async function instantiateSession(
  input: InstantiateInput
): Promise<FocusSession> {
  const db = await getDb();
  const playbook = await db.query.playbooks.findFirst({
    where: eq(playbooks.id, input.playbookId),
  });
  if (!playbook) {
    throw new Error(`Playbook ${input.playbookId} not found`);
  }

  const goal = resolveGoal(
    playbook.goalTemplate,
    (input.params ?? {}) as Record<string, unknown>
  );
  const expectedOutputs = (playbook.expectedOutputs as ExpectedOutput[]) ?? [];

  const [session] = await db
    .insert(focusSessions)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      goal,
      playbookId: playbook.id,
      projectId: input.projectId ?? null,
      subjectEntityId: input.subjectId ?? null,
      expectedOutputs,
      channelId: input.channelId ?? null,
      agentIds: input.agentIds ?? [],
      status: "active",
    })
    .returning();

  // Provenance edges.
  const edges: LinkInput[] = [
    {
      workspaceId: input.workspaceId,
      fromType: "session",
      fromId: session.id,
      toType: "playbook",
      toId: playbook.id,
      linkType: "instantiated_from",
    },
  ];

  // Project scope: session → targets → project (additive; only when provided).
  if (input.projectId) {
    edges.push({
      workspaceId: input.workspaceId,
      fromType: "session",
      fromId: session.id,
      toType: "project",
      toId: input.projectId,
      linkType: "targets",
    });
  }

  await createLinks(edges);

  return session as FocusSession;
}

export interface PromoteInput {
  sessionId: string;
  /** The promoting principal (used to scope the capability-link read). */
  userId: string;
  /** Optional name for the new playbook (defaults to the session goal). */
  name?: string;
  description?: string;
}

/**
 * Promote a validated session into a reusable Playbook. Caller MUST gate first.
 */
export async function promoteSessionToPlaybook(
  input: PromoteInput
): Promise<Playbook> {
  const db = await getDb();
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, input.sessionId),
  });
  if (!session) {
    throw new Error(`Session ${input.sessionId} not found`);
  }

  // Guard the latent project-scope hole: playbooks.workspaceId is NOT NULL, so a
  // project-scoped session (null workspace) would fail the insert at the DB. No
  // path creates such a session today (P4b) — fail with a clear message rather
  // than a raw constraint violation.
  if (!session.workspaceId) {
    throw new Error(
      "Project-scoped sessions (no workspace) cannot be promoted to a playbook yet."
    );
  }

  // Capabilities the session USED → re-grant them on the new playbook.
  const sessionLinks = await getLinksFor(input.userId, "session", session.id);
  const grantedCaps = extractCapabilities(sessionLinks, {
    linkType: "used",
    fromType: "session",
  });

  const [playbook] = await db
    .insert(playbooks)
    .values({
      workspaceId: session.workspaceId,
      createdBy: input.userId,
      name: input.name ?? session.goal.slice(0, 200),
      description: input.description ?? null,
      goalTemplate: session.goal,
      expectedOutputs: (session.expectedOutputs as ExpectedOutput[]) ?? [],
      executor: "is-agent",
      status: "draft",
      // Lineage lives in the `session → promoted_to → playbook` edge below — the
      // single source of truth — not duplicated here.
    })
    .returning();

  // Lineage + re-granted capabilities, all as graph edges.
  const edges: LinkInput[] = [
    {
      workspaceId: session.workspaceId,
      fromType: "session",
      fromId: session.id,
      toType: "playbook",
      toId: playbook.id,
      linkType: "promoted_to",
    },
    ...grantedCaps.map(
      (cap): LinkInput => ({
        workspaceId: session.workspaceId,
        fromType: "playbook",
        fromId: playbook.id,
        toType: cap.kind,
        toId: cap.id,
        linkType: "grants",
      })
    ),
  ];
  await createLinks(edges);

  return playbook as Playbook;
}
