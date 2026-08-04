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

import {
  getDb,
  eq,
  and,
  isNull,
  ne,
  asc,
  drizzleSql,
  focusSessions,
  playbooks,
} from "@synap/database";
import type { Playbook, FocusSession } from "@synap/database/schema";
import type {
  ExpectedOutput,
  LinkInput,
  PlaybookStage,
} from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import { parseCommandTemplate } from "../../utils/command-template.js";
import { authoringMisses } from "../../utils/template-diagnostics.js";
import {
  createLinks,
  extractCapabilities,
  getLinksFor,
} from "../links/links-service.js";

const logger = createLogger({ module: "playbook-lifecycle" });

/** Postgres unique-violation SQLSTATE — playbooks_workspace_name_active_uq (0227). */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/**
 * Resolve a playbook's goalTemplate against caller-supplied param values.
 *
 * An unresolved reference still renders as `""` (or, for a bare `{name}`, as
 * the literal braces) — flows depend on that and it does not change here. What
 * changes is that it is no longer SILENT: the substitution runs inside a
 * diagnostics scope and the authoring-level misses are logged with the
 * playbook's id, so "the agent ignored my param" is greppable instead of being
 * a mutilated prompt nobody can explain.
 */
export function resolveGoal(
  goalTemplate: string,
  params: Record<string, unknown>,
  playbookId?: string
): string {
  const argValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    argValues[k] = v == null ? "" : String(v);
  }
  const { text, misses } =
    parseCommandTemplate(goalTemplate).substituteWithMisses(argValues);
  const reportable = authoringMisses(misses);
  if (reportable.length > 0) {
    logger.warn(
      { playbookId, misses: reportable },
      "Playbook goal template had references that resolved to nothing"
    );
  }
  return text;
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
   * When provided, the session is anchored to a project (projects TABLE row,
   * NOT an entity) and a `session --targets--> project` link is written.
   * workspaceId is still required for the channel / workspace membership
   * context even when projectId is set.
   */
  projectId?: string | null;
  /**
   * The entity this session is about (e.g. a contact, deal, or document).
   * Stored as focus_sessions.subjectEntityId — threads RunContext.subjectId
   * through from the playbook run input.
   */
  subjectId?: string | null;
  /**
   * Pre-resolved goal. When set, it OVERRIDES the goalTemplate substitution —
   * used by the scheduled path, which resolves the goal against the automation
   * StepContext (trigger payload + prior step outputs) before this runs. Absent
   * ⇒ the goalTemplate is substituted against `params` as before.
   */
  goalOverride?: string;
  /**
   * Extra session metadata to stamp at creation (merged into focus_sessions.metadata).
   * Carries the automation chain context (F2 depth floor) and the propose-only
   * governance stamp for scheduled/maintenance runs. Absent ⇒ the column default ({}).
   */
  metadata?: Record<string, unknown>;
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

  const goal =
    input.goalOverride ??
    resolveGoal(
      playbook.goalTemplate,
      (input.params ?? {}) as Record<string, unknown>,
      playbook.id
    );
  const expectedOutputs = (playbook.expectedOutputs as ExpectedOutput[]) ?? [];
  // Seed the active stage from the playbook's first stage (null when stageless,
  // so a no-stage playbook stays progress-only — currentStage never NOT NULL).
  const stages = (playbook.stages as PlaybookStage[]) ?? [];
  const currentStage = stages[0]?.key ?? null;

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
      currentStage,
      channelId: input.channelId ?? null,
      agentIds: input.agentIds ?? [],
      status: "active",
      ...(input.metadata && Object.keys(input.metadata).length > 0
        ? { metadata: input.metadata }
        : {}),
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
  // NB: `used` edges are part-only today (every `used`-edge writer constrains the
  // kind to tool|skill|command), so `extractCapabilities` (which drops container
  // edges) is correct here. If a `used --> capability` edge ever becomes possible,
  // switch this to `resolveGrantedCapabilities` so the container fans out to its
  // members rather than being silently dropped.
  const sessionLinks = await getLinksFor(input.userId, "session", session.id);
  const grantedCaps = extractCapabilities(sessionLinks, {
    linkType: "used",
    fromType: "session",
  });

  // If this session was instantiated from a playbook that belongs to capability
  // container(s), the PROMOTED playbook joins the SAME capabilities as a
  // `member_of` member. This is the promote-path half of the "capability →
  // materialized flow" edge (create-from-definition seeds the other half): a
  // playbook distilled from a capability's run stays part of that capability's
  // materialized set, so the composition map stays complete. No session ever
  // carries a direct `session --> capability` edge today, so the source is read
  // transitively off the origin playbook's own `member_of` links.
  let sourceCapabilityIds: string[] = [];
  if (session.playbookId) {
    const originLinks = await getLinksFor(
      input.userId,
      "playbook",
      session.playbookId
    );
    sourceCapabilityIds = [
      ...new Set(
        originLinks
          .filter(
            (l) =>
              l.fromType === "playbook" &&
              l.fromId === session.playbookId &&
              l.toType === "capability" &&
              l.linkType === "member_of"
          )
          .map((l) => l.toId)
      ),
    ];
  }

  const name = input.name ?? session.goal.slice(0, 200);
  let playbook: Playbook;
  let reused = false;
  try {
    const [row] = await db
      .insert(playbooks)
      .values({
        workspaceId: session.workspaceId,
        createdBy: input.userId,
        name,
        description: input.description ?? null,
        goalTemplate: session.goal,
        expectedOutputs: (session.expectedOutputs as ExpectedOutput[]) ?? [],
        executor: "is-agent",
        status: "draft",
        // Lineage lives in the `session → promoted_to → playbook` edge below — the
        // single source of truth — not duplicated here.
      })
      .returning();
    playbook = row as Playbook;
  } catch (err) {
    // 0227: concurrent promote / same-name race — return the surviving non-archived
    // playbook instead of failing the promote door.
    if (!isUniqueViolation(err)) throw err;
    const scope = session.workspaceId
      ? eq(playbooks.workspaceId, session.workspaceId)
      : isNull(playbooks.workspaceId);
    const [winner] = await db
      .select()
      .from(playbooks)
      .where(
        and(
          scope,
          drizzleSql`lower(${playbooks.name}) = lower(${name})`,
          ne(playbooks.status, "archived")
        )
      )
      .orderBy(asc(playbooks.createdAt), asc(playbooks.id))
      .limit(1);
    if (!winner) throw err;
    playbook = winner as Playbook;
    reused = true;
    logger.info(
      { playbookId: playbook.id, name, sessionId: session.id },
      "promoteSessionToPlaybook: unique violation — returning existing playbook"
    );
  }

  // Lineage + re-granted capabilities, all as graph edges. createLinks is
  // onConflict-safe, so re-wiring on a reused playbook is idempotent.
  const edges: LinkInput[] = [
    {
      workspaceId: session.workspaceId,
      fromType: "session",
      fromId: session.id,
      toType: "playbook",
      toId: playbook.id,
      linkType: "promoted_to",
    },
    ...grantedCaps.map((cap): LinkInput => ({
      workspaceId: session.workspaceId,
      fromType: "playbook",
      fromId: playbook.id,
      toType: cap.kind,
      toId: cap.id,
      linkType: "grants",
    })),
    // Inherit the origin playbook's capability membership (see above).
    ...sourceCapabilityIds.map((capId): LinkInput => ({
      workspaceId: session.workspaceId,
      fromType: "playbook",
      fromId: playbook.id,
      toType: "capability",
      toId: capId,
      linkType: "member_of",
    })),
  ];
  await createLinks(edges);

  if (reused) {
    logger.debug(
      { playbookId: playbook.id, sessionId: session.id },
      "promoteSessionToPlaybook: reused existing playbook (idempotent)"
    );
  }

  return playbook;
}
