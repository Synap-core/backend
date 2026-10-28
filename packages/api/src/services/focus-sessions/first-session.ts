/**
 * The first session with a goal (onboarding start step S6, plan v1 §2.6,
 * slice A8): the person hands their connected agent its first job.
 *
 * ONE create door: `createFocusSession`, with the internal-only
 * `governance: {forceProposeWrites: true}` stamp. The gate already re-reads
 * that stamp on every AI write carrying the session
 * (`permission-check.ts`, `loadSessionGovernanceContext`), so every agent
 * write in this session is a proposal the person approves: the designed peak
 * of the start is the first approval. The same agent's writes OUTSIDE the
 * session keep their ordinary governance. When the person's E3 arm is
 * `default`, the stamp is omitted.
 *
 * Every input is read from what the pod already holds, never trusted from the
 * client: the start (`values.start.intent.slug` → the bundled template's
 * `meta.start.firstSession`), the space (the APPROVED setup proposal's
 * `materializedWorkspaceId`), the agent (`values.start.agent.agentUserId`,
 * which must be an agent the person operates), and the deliverables (the
 * space brief's `collect[]`, one slot per required record).
 *
 * Idempotent: an open `values.start.firstSession.sessionId` is handed back,
 * and concurrent starts are serialized per person, so one person gets one
 * session.
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  drizzleSql,
  eq,
  focusSessions,
  onboardingJourneys,
  proposals,
  workspaces,
  withAdvisoryLock,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";
import { getWorkspaceTemplate } from "@synap-core/workspace-templates";
import type { StartValues } from "@synap-core/types/onboarding/start";
import {
  readSpaceBrief,
  type SpaceBriefCollectTarget,
} from "@synap-core/types/space-brief";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { agentsOperatedBy } from "../agent-presence.js";
import { createFocusSession } from "./create-session.js";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";

/** The start journey row: the pod lens, template version 1 (plan §2.2). */
const START_LENS_KEY = "pod";
const START_TEMPLATE_VERSION = "1";

/** At most this many slots per collected kind: a brief's `min` is a floor, not a quota. */
const MAX_SLOTS_PER_KIND = 5;

export interface StartFirstSessionResult {
  sessionId: string;
  /** True when the open first session was handed back, nothing created. */
  reused: boolean;
  /** Whether agent writes in the session propose (`propose`) or follow the pod's rules (`default`). */
  governance: "propose" | "default";
}

function refuse(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

/** `meta.start.firstSession` of a bundled template, or null when it declares none. */
export function readStartFirstSession(
  slug: string
): { title: string; goal: string } | null {
  const start = (
    getWorkspaceTemplate(slug)?.meta as { start?: unknown } | undefined
  )?.start as
    { firstSession?: { title?: unknown; goal?: unknown } } | undefined;
  const title = start?.firstSession?.title;
  const goal = start?.firstSession?.goal;
  return typeof title === "string" &&
    title.trim() &&
    typeof goal === "string" &&
    goal.trim()
    ? { title: title.trim(), goal: goal.trim() }
    : null;
}

/**
 * The session's deliverables from the space brief's `collect[]`: one slot per
 * required record of each kind (`min`, capped), named by the kind's noun. A
 * target with no `min` asks for nothing, so it owes nothing.
 */
export function firstSessionOutputs(
  collect: readonly SpaceBriefCollectTarget[]
): ExpectedOutput[] {
  return collect.flatMap((target) => {
    const count = Math.min(Math.max(target.min ?? 0, 0), MAX_SLOTS_PER_KIND);
    const noun = resolveObjectNoun(target.profileSlug);
    return Array.from({ length: count }, (_, i) => ({
      kind: target.profileSlug,
      label: count > 1 ? `${noun} ${i + 1}` : noun,
    }));
  });
}

async function readStartValues(userId: string): Promise<StartValues | null> {
  const [row] = await db
    .select({ progress: onboardingJourneys.progress })
    .from(onboardingJourneys)
    .where(
      and(
        eq(onboardingJourneys.userId, userId),
        eq(onboardingJourneys.lensKey, START_LENS_KEY),
        eq(onboardingJourneys.templateVersion, START_TEMPLATE_VERSION)
      )
    )
    .limit(1);
  const start = row?.progress?.values?.start;
  return start && typeof start === "object" ? (start as StartValues) : null;
}

async function openSessionId(
  userId: string,
  sessionId: string
): Promise<string | null> {
  const row = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
    columns: { id: true, status: true },
  });
  return row &&
    (OPEN_SESSION_STATUSES as readonly string[]).includes(row.status)
    ? row.id
    : null;
}

/** The space the approved setup created: its primary (the template's own) space. */
async function setupSpace(
  userId: string,
  proposalId: string
): Promise<{ id: string; settings: unknown }> {
  const [proposal] = await db
    .select({ status: proposals.status, data: proposals.data })
    .from(proposals)
    .where(
      and(eq(proposals.id, proposalId), eq(proposals.subjectUserId, userId))
    )
    .limit(1);
  if (!proposal || proposal.status !== ProposalStatus.APPROVED) {
    refuse("Approve your setup first: the first session works in its space.");
  }
  const workspaceId = (
    proposal.data as { materializedWorkspaceId?: unknown } | null
  )?.materializedWorkspaceId;
  if (typeof workspaceId !== "string") {
    refuse("Your approved setup created no space to work in.");
  }
  const [space] = await db
    .select({
      id: workspaces.id,
      settings: workspaces.settings,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!space || space.archivedAt) {
    refuse("The space your setup created is archived. Restore it first.");
  }
  return { id: space.id, settings: space.settings };
}

/** Writes `values.start.firstSession` in one statement, leaving every other value as it is. */
async function recordFirstSession(
  userId: string,
  sessionId: string
): Promise<void> {
  const value = JSON.stringify({ sessionId, at: new Date().toISOString() });
  await db
    .update(onboardingJourneys)
    .set({
      progress: drizzleSql`jsonb_set(${onboardingJourneys.progress}, '{values,start,firstSession}', ${value}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(onboardingJourneys.userId, userId),
        eq(onboardingJourneys.lensKey, START_LENS_KEY),
        eq(onboardingJourneys.templateVersion, START_TEMPLATE_VERSION)
      )
    );
}

export async function startFirstSession(input: {
  userId: string;
}): Promise<StartFirstSessionResult> {
  const { userId } = input;
  return withAdvisoryLock("onboarding-first-session", userId, async () => {
    const start = await readStartValues(userId);
    const governance =
      (start as { experiments?: { firstSessionGovernance?: unknown } } | null)
        ?.experiments?.firstSessionGovernance === "default"
        ? "default"
        : "propose";

    const existing = start?.firstSession?.sessionId;
    if (existing) {
      const open = await openSessionId(userId, existing);
      if (open) return { sessionId: open, reused: true, governance };
    }

    const slug = start?.intent?.slug;
    if (!slug) refuse("Choose a start first.");
    const proposalId = start?.setup?.proposalId;
    if (!proposalId) refuse("Set up your space first.");
    const agentUserId = start?.agent?.agentUserId;
    if (!agentUserId) refuse("Connect your agent first.");

    const declared = readStartFirstSession(slug);
    if (!declared) {
      refuse(`The start "${slug}" declares no first session.`);
    }
    const operated = await agentsOperatedBy(userId, [agentUserId]);
    if (!operated.has(agentUserId)) {
      refuse("The connected agent is not one of yours. Connect it again.");
    }
    const space = await setupSpace(userId, proposalId);

    const result = await createFocusSession({
      userId,
      workspaceId: space.id,
      title: declared.title,
      goal: declared.goal,
      agentIds: [agentUserId],
      expectedOutputs: firstSessionOutputs(
        readSpaceBrief(space.settings)?.collect ?? []
      ),
      ...(governance === "propose"
        ? { governance: { forceProposeWrites: true as const } }
        : {}),
      // An older open session with the same goal is not this one: it carries
      // no stamp, so the first session is always its own row.
      forceCreate: true,
    });
    if (result.status !== "created") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The first session was not created. Nothing was started.",
      });
    }
    await recordFirstSession(userId, result.session.id);
    return { sessionId: result.session.id, reused: false, governance };
  });
}
