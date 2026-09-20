/**
 * createFocusSession — shared service behind both Hub REST and MCP adapter.
 *
 * Creates a focus session (goal-bound work session) with governance gating.
 * Idempotent by correlationId. Emits realtime events for browser mirroring.
 */
import {
  db,
  focusSessions,
  playbooks,
  playbookRuns,
  eq,
  and,
  drizzleSql,
  findClientSession,
  normalizeGoal,
  recordSessionSpawn,
  resolveSessionProjectPlacement,
  isProbeWriteContext,
  stampProbeMarker,
} from "@synap/database";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { randomUUID } from "node:crypto";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { ensureSessionChannel } from "./ensure-session-channel.js";
import { createLogger } from "@synap-core/core";
import type { ExpectedOutput, SessionCriterion } from "@synap/playbooks";
import {
  collectPlaybookCriteria,
  mergeCriteria,
  readPlaybookParams,
  validatePlaybookParams,
} from "@synap/playbooks";
import { sessionCriteriaSchema } from "../../schemas/session-criteria.js";
import { RUN_PARAMS_METADATA_KEY } from "../playbooks/playbook-lifecycle.js";
import {
  matchSessionTemplate,
  type SessionPlaybookCandidates,
} from "./match-session-template.js";
import { sanitizeDeclaredOutputs } from "./update-session.js";
import {
  guidanceForBlockedSlots,
  newlyBlockedSlots,
  type BlockGuidance,
} from "./block-guidelines.js";
// STATIC — see the note on the same import in `update-session.ts`: there is no
// cycle here, the `await import()` this replaces stated no reason, and
// `block-output.ts` has always imported this module statically.
import {
  findUnreachableOutputRefs,
  unreachableOutputRefError,
} from "./assert-output-ref-visible.js";
import {
  addCreateTimeBlockers,
  type CreateTimeBlockerReport,
} from "./session-blocked-by.js";
import {
  findOpenSessionTwin,
  type SessionTwinCandidate,
} from "./find-open-session-twin.js";
import {
  normalizeSessionTitle,
  PARAM_SLOT_KIND,
  SESSION_TITLE_MAX,
  titleSourcePatch,
  canAutoRetitle,
} from "@synap-core/types/focus-sessions";

const logger = createLogger({ module: "focus-sessions/create-session" });

/** RFC-4122 UUID shape — templateId may be a legacy free-text template name. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key of a playbook's first stage, or null for a stageless playbook.
 * Stages are stored as JSONB, so this stays defensive about shape rather than
 * trusting the row to be well-formed.
 */
export function firstStageKey(stages: unknown): string | null {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const first = stages[0] as { key?: unknown } | null;
  const key = first && typeof first === "object" ? first.key : undefined;
  return typeof key === "string" && key.length > 0 ? key : null;
}

export interface CreateFocusSessionParams {
  userId: string;
  /**
   * Workspace the session belongs to. Optional — a session may instead be
   * anchored to a project or live on the user floor. When null/undefined the governance membrane
   * treats it as a personal resource and auto-grants (no membership needed).
   */
  workspaceId?: string | null;
  projectId?: string | null;
  /**
   * The entity this session is "about" — the subject-spine anchor. Written on
   * the ad-hoc start path so a session can be tied to a person/company/deal.
   */
  subjectEntityId?: string | null;
  /**
   * Short optional one-line NAME, separate from `goal` (the outcome). Blank ⇒
   * null (untitled; surfaces show the goal's first line via
   * `resolveSessionTitle`). Longer than `SESSION_TITLE_MAX` is refused.
   */
  title?: string | null;
  goal: string;
  agentUserId?: string;
  correlationId?: string;
  channelId?: string | null;
  agentIds?: string[];
  templateId?: string | null;
  /**
   * Answers to the playbook's declared params, when `templateId` names a real
   * playbook. Until this existed the door could not accept them AT ALL: a
   * session started from a parameterised playbook remembered nothing about what
   * it was for.
   *
   * This door ALWAYS OWES an unanswered required param and never refuses one —
   * unlike the run doors, and deliberately. A run's instruction IS the rendered
   * `goalTemplate`, so a hole in it mutilates the agent's whole brief; here the
   * instruction is the CALLER's own `goal` and the playbook is structure laid
   * beside it. Nothing is mutilated by an unanswered param, so refusing would
   * block a session the person is already describing in their own words.
   * A MISTYPED value still refuses, on every door — see
   * `InstantiateInput.onMissingRequired`.
   */
  params?: Record<string, unknown>;
  /**
   * Declared deliverables. The SHARED type, not an inline copy — the four-field
   * inline shape that used to sit here quietly narrowed what this door believed
   * a slot was, so a slot's delegation, its return note and (now) its
   * blocked-on-human declaration were invisible to the create path.
   */
  expectedOutputs?: ExpectedOutput[];
  /**
   * The PARENT of this session — a child is either a detour or a planned
   * sub-session; both are the ONE edge `session --spawned_from--> session`
   * (never a column: see `schema/links.ts`). The parent stays open and lists its
   * children; closing either never closes the other. The parent must belong to
   * the same user; an unowned or unknown parent does not fail the create, and
   * the miss is REPORTED on the result as `parentLink` — never a silent drop.
   *
   * The child NEVER inherits the parent's `metadata` — least of all
   * `metadata.governance`, which `deriveSessionForceProposeGovernance` reads to
   * force-propose every AI write in the session.
   */
  parentSessionId?: string | null;
  /**
   * "What were you about to do" — one line captured at SUSPENSION and written
   * onto the PARENT's `metadata.suspended`, so popping back restates the goal.
   * Only meaningful together with `parentSessionId`.
   */
  suspendedIntent?: string | null;
  /**
   * Sessions this one is BLOCKED BY, declared at birth. Each becomes a
   * `session --blocked_by--> session` edge through `addCreateTimeBlockers` (the
   * same validate + write door as `POST /links`), after the row exists; each
   * outcome is reported per id on `blockerLinks`. On the PROPOSED path they ride
   * the proposal and are written at approval.
   */
  blockedBySessionIds?: string[];
  /**
   * Open a NEW session even when an OPEN session of the same user, normalized
   * goal and scope exists. Without it that session is returned as `deduped`.
   */
  forceCreate?: boolean;
  /**
   * Binary acceptance criteria — the definition of done (`focus_sessions.
   * criteria`, Lane B's contract). Validated with the shared write schema; at
   * most `MAX_SESSION_CRITERIA`. A template's own criteria are added after.
   */
  criteria?: SessionCriterion[];
  /**
   * The CALLING CLIENT (`key:<apiKeyId>`, see `clientKeyForApiKey`). Stamped
   * on the new row as `metadata.clientKey`, which binds the session to that
   * client for write attribution — and, when the gate already AUTO-OPENED a
   * session for this client, that session is ADOPTED instead of a second one
   * being created (session-first: an explicit start always wins, never
   * duplicates). Absent for a human start.
   */
  clientKey?: string | null;
  /**
   * Rank the pod's playbooks against this session's words when the caller
   * named none (`templateId` undefined — an explicit `null` skips matching).
   * Set by the AI start doors only. NOTHING is applied: the ranked candidates
   * ride back on `playbooks` for the caller to choose from.
   */
  matchTemplate?: boolean;
}

/** What happened to the create-time `spawned_from` edge. */
export type CreateTimeParentLink =
  | {
      status: "linked";
      parentSessionId: string;
      suspendedIntentRecorded: boolean;
    }
  | {
      status: "failed";
      parentSessionId: string;
      reason: "parent_not_found" | "self_parent" | "error";
      message?: string;
    };

export type CreateFocusSessionResult =
  | {
      status: "created";
      session: typeof focusSessions.$inferSelect;
      /** Guidelines for any slot declared already blocked on the human. */
      blockGuidelines?: BlockGuidance;
      /** Present iff a `parentSessionId` was given. */
      parentLink?: CreateTimeParentLink;
      /** Present iff `blockedBySessionIds` was non-empty — one entry per id. */
      blockerLinks?: CreateTimeBlockerReport[];
      /** Near-goal OPEN sessions in the same scope — suggested, never blocking. */
      candidates?: SessionTwinCandidate[];
      /**
       * Present iff playbook matching ran — the pod's existing processes,
       * ranked against this session's words, with the reason each matched.
       * Suggestions only; nothing here was applied. Bind one by starting
       * again with `templateId`, or carry on ad-hoc.
       */
      playbooks?: SessionPlaybookCandidates;
      /**
       * True when the session the gate had auto-opened for this client was
       * adopted (goal/title/criteria updated) rather than a new row
       * created. `session.id` is then that session's id.
       */
      adopted?: true;
    }
  | {
      /**
       * An OPEN session of the same user, normalized goal and scope already
       * existed, so THAT session is returned and nothing was written. Pass
       * `forceCreate` to open a second one on purpose.
       */
      status: "deduped";
      session: typeof focusSessions.$inferSelect;
      candidates: SessionTwinCandidate[];
    }
  | {
      status: "proposed";
      proposalId: string;
      /**
       * Which proposed outcome this is: a CONTENT proposal, or a workspace-JOIN
       * gate filed INSTEAD of the write. Callers derive their sentence from it
       * (`proposedMessageFor`); without it on the TYPE the value cannot cross
       * this boundary and the door has to hardcode a claim it cannot check.
       */
      proposalType?: string;
      message: string;
      summary?: string;
      reasoning?: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

export async function createFocusSession(
  params: CreateFocusSessionParams
): Promise<CreateFocusSessionResult> {
  const {
    userId,
    workspaceId = null,
    projectId: explicitProjectId = null,
    subjectEntityId = null,
    title: rawTitle = null,
    goal,
    agentUserId,
    correlationId,
    channelId = null,
    agentIds = [],
    templateId: requestedTemplateId = null,
    expectedOutputs = [],
    parentSessionId = null,
    suspendedIntent = null,
    blockedBySessionIds = [],
    clientKey = null,
  } = params;
  let templateId = requestedTemplateId;

  // Refused, never truncated: a clipped name is a claim the caller did not make.
  const title = normalizeSessionTitle(rawTitle);
  if (title && title.length > SESSION_TITLE_MAX) {
    throw Object.assign(
      new Error(
        `title must be at most ${SESSION_TITLE_MAX} characters — ONE line naming the session; put the outcome in goal.`
      ),
      { code: "BAD_REQUEST" }
    );
  }

  // Criteria are a CONTROL: validated with the shared write schema (strict,
  // capped), refused in words rather than stored half-right.
  let criteria: SessionCriterion[] = [];
  if (params.criteria !== undefined) {
    const parsed = sessionCriteriaSchema.safeParse(params.criteria);
    if (!parsed.success) {
      throw Object.assign(
        new Error(
          `Invalid criteria: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "criteria"}: ${i.message}`)
            .join("; ")}`
        ),
        { code: "BAD_REQUEST" }
      );
    }
    criteria = parsed.data as SessionCriterion[];
  }

  // Idempotency: correlationId returns the existing session for this user,
  // scoped to the same workspace when one is given.
  if (correlationId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.correlationId, correlationId),
        eq(focusSessions.userId, userId),
        ...(workspaceId ? [eq(focusSessions.workspaceId, workspaceId)] : [])
      ),
    });
    if (existing) return { status: "created", session: existing };
  }

  // PROJECT LENS — derived from the context this door already holds, rather
  // than waited for. Before this, `projectId` was whatever the caller passed and
  // essentially nobody passed one (measured: 10% of sessions). The ladder's
  // rung 1 is the caller's own pin, so an explicit project is byte-identical to
  // before; the widening is only over the callers that supplied nothing.
  //
  // Placed BEFORE the governance membrane so the derived lens is the one stamped
  // on the proposal's provenance too. `projectId` is PROVENANCE in
  // `checkPermissionOrPropose` (it is folded into the WriteEnvelope and never
  // read by an access decision), so deriving it here cannot widen a permission.
  //
  // `NONE` → null. No AI rung, no "the only project" fallback.
  const projectId = (
    await resolveSessionProjectPlacement(db, {
      userId,
      explicitProjectId,
      parentSessionId,
      channelId,
      subjectEntityId,
    })
  ).projectId;

  // DEDUP — the SAME question the approve executor asks before its insert
  // (`findOpenSessionTwin`). Live, every duplicate pair was an approved
  // proposal's session plus a direct create of the same goal ms later. An
  // exact open twin (same user, normalized goal, scope) is RETURNED, flagged
  // `deduped` — never silent, never merged. Near goals only ride `candidates`.
  // After the project lens (the scope compares the DERIVED project) and before
  // the membrane, so a twin never files a proposal for work that already exists.
  const twinMatch = await findOpenSessionTwin({
    userId,
    goal,
    workspaceId,
    projectId,
    parentSessionId,
    templateId,
  });
  if (twinMatch.exact && !params.forceCreate) {
    return {
      status: "deduped",
      session: twinMatch.exact,
      candidates: twinMatch.candidates,
    };
  }

  // PLAYBOOKS — only when the AI door asked and the caller named none
  // (`templateId: null` skips matching). SUGGEST-ONLY since 2026-09-20: the
  // door hands back the pod's existing processes, ranked, and applies NOTHING.
  // Naming `templateId` is the only way a playbook binds at start. After the
  // twin check, so a repeated start of the same work still dedups.
  let playbookCandidates: SessionPlaybookCandidates | undefined;
  if (params.matchTemplate && params.templateId === undefined) {
    try {
      playbookCandidates = await matchSessionTemplate({
        userId,
        agentUserId,
        workspaceId,
        title,
        goal,
      });
    } catch (err) {
      // Suggestions are a courtesy, never a gate. A failed lookup must not
      // read as "you have no playbooks", so the block is OMITTED rather than
      // returned empty — an empty list and a failed read are different facts.
      logger.warn(
        { err },
        "playbook match failed — starting with no candidates"
      );
    }
  }

  // ADOPTION — the gate already auto-opened a session for this client (its
  // first write arrived before it started one). Starting now must not leave two
  // rows for one piece of work: that session becomes this one.
  const adoptId = clientKey
    ? ((await findClientSession(userId, clientKey, { onlyAutoOpened: true }))
        ?.id ?? null)
    : null;

  // VISIBILITY FLOOR for any `ref` a declared slot carries — the SAME
  // `isOutputRefVisible` the attach-output and update doors apply, and BEFORE
  // the membrane so a ref the caller cannot see is refused to the caller who
  // wrote it rather than laundered into the human's proposal queue.
  //
  // Thrown as FORBIDDEN rather than returned: this result type has no refusal
  // member, and the door beside it (`perm.denied`) already refuses this way.
  if (expectedOutputs.length > 0) {
    const unreachable = await findUnreachableOutputRefs({
      userId,
      outputs: expectedOutputs,
    });
    if (unreachable.length > 0) {
      throw Object.assign(new Error(unreachableOutputRefError(unreachable)), {
        code: "FORBIDDEN",
      });
    }
  }

  // Governance membrane — AI callers route through proposals. A session with no
  // workspace is a personal resource and auto-grants via checkPermissionOrPropose.
  // The session's id is minted ONCE, here, and travels as `data.id`: the
  // auto-approve receipt stamps it as its targetId and the PROPOSED path makes
  // it the prospective id the executor inserts at. Left to the column default,
  // the receipt minted its own random id that no row ever had (live receipt
  // 91191f04, 2026-09-14). The dedup hash strips `id`, so retries still dedup.
  const sessionId = randomUUID();

  // If `templateId` is a real Playbook id, this session IS a playbook run: wire
  // the canonical `playbookId` + a `playbook_runs` ledger row so it surfaces in
  // the runs feed. Writing ONLY the deprecated `templateId` (legacy behavior, kept
  // below for compat) produced disconnected "ghost" sessions that ran forever with
  // no ledger row. A non-UUID / free-text templateId resolves to no playbook →
  // unchanged legacy behavior. (Guard the UUID first — comparing a uuid column to
  // free text throws in Postgres.)
  const playbook =
    templateId && UUID_RE.test(templateId)
      ? ((await db.query.playbooks.findFirst({
          where: eq(playbooks.id, templateId),
        })) ?? null)
      : null;

  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: workspaceId ?? undefined,
    projectId: projectId ?? undefined,
    subjectType: "focus_session",
    action: "create",
    source: "intelligence",
    // Carry the non-goal fields through the proposal so the approve executor
    // (proposals/approve-executors.ts, focus_session/create) can materialize a
    // full session — otherwise they'd be lost on the PROPOSED path. Only include
    // when present to keep the persisted data lean.
    data: {
      id: sessionId,
      goal,
      // Also the proposal's display name (`extractProposalName` reads `title`).
      ...(title ? { title } : {}),
      templateId,
      // A real playbook: the approve executor materializes through the SAME
      // body a direct instantiate uses (`instantiateSessionRow` via its
      // `playbookId` branch) — playbook, first stage, run shape — instead of
      // landing an untemplated row that only remembers `templateId`. That
      // branch needs the workspace the playbook runs in, so a project-only
      // (workspace-less) start keeps the legacy row on the proposed path.
      ...(playbook && workspaceId ? { playbookId: playbook.id } : {}),
      // The template's param answers ride the proposal too. Without them the
      // PROPOSED path would materialize a run that remembers nothing it was
      // given, while the direct path stored them — the two-paths-disagree
      // shape. Validated at the funnel on approval (`instantiateSessionRow`,
      // which the `playbookId` branch materializes through).
      ...(playbook && workspaceId && params.params
        ? { params: params.params }
        : {}),
      ...(subjectEntityId ? { subjectEntityId } : {}),
      ...(channelId ? { channelId } : {}),
      // Sanitized BEFORE it is proposed, so the payload a human reviews is the
      // one that will be written — a proposal showing `attestedBy: "Antoine"`
      // is asking someone to approve a claim about themselves. The executor
      // floors it again at the write, because these two moments are weeks apart
      // and only the second one is the door.
      ...(expectedOutputs.length > 0
        ? { expectedOutputs: sanitizeDeclaredOutputs(expectedOutputs) }
        : {}),
      ...(agentIds.length > 0 ? { agentIds } : {}),
      // Detour lineage must survive the PROPOSED path too, or an agent-opened
      // detour silently loses its parent on approval (the plumbed-field-with-
      // no-producer shape this whole slice exists to retire). Applied by
      // `proposals/executors/focus-session.ts` after the row is inserted.
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(suspendedIntent ? { suspendedIntent } : {}),
      // Same reason: written at approval through `addCreateTimeBlockers`.
      ...(blockedBySessionIds.length > 0 ? { blockedBySessionIds } : {}),
      ...(criteria.length > 0 ? { criteria } : {}),
    },
  });

  if ("denied" in perm && perm.denied) {
    throw Object.assign(new Error(perm.reason), { code: "FORBIDDEN" });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      message: proposedMessageFor(
        perm.proposalType,
        "Focus session creation proposed for review"
      ),
      summary: perm.summary,
      reasoning: perm.reasoning,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  // A template's criteria join the caller's (keys unique, caller's first).
  const sessionCriteria = playbook
    ? mergeCriteria(criteria, collectPlaybookCriteria(playbook))
    : criteria;

  // PARAMS — the same pure validator the run funnel uses, so this door and
  // `instantiateSessionRow` can never disagree about what an answer is. A
  // MISTYPED value refuses (a malformed call, not an unanswered question); a
  // missing required one becomes an owed slot, for the reason stated on
  // `CreateFocusSessionParams.params`.
  const paramResolution = playbook
    ? validatePlaybookParams(readPlaybookParams(playbook.params), params.params)
    : null;
  if (paramResolution && paramResolution.typeErrors.length > 0) {
    const [first] = paramResolution.typeErrors;
    throw Object.assign(
      new Error(
        first!.options
          ? `"${first!.name}" must be one of ${first!.options.map((o) => `"${o}"`).join(", ")} — got "${first!.received}".`
          : `"${first!.name}" must be a ${first!.type} — got "${first!.received}".`
      ),
      { code: "BAD_REQUEST" }
    );
  }
  const paramOwedAt = new Date().toISOString();
  const paramSlots: ExpectedOutput[] = (
    paramResolution?.missingRequired ?? []
  ).map((p) => ({
    kind: PARAM_SLOT_KIND,
    label: `Answer: ${p.label?.trim() || p.name}`,
    owner: "human" as const,
    blockedReason: "decision" as const,
    why: `"${playbook!.name}" needs a value for "${p.label?.trim() || p.name}"${
      p.options?.length
        ? ` (one of ${p.options.map((o) => `"${o}"`).join(", ")})`
        : ` (${p.type})`
    }. Nobody supplied it when this session was started.`,
    owedSince: paramOwedAt,
  }));

  // Session + its playbook_runs ledger row land in ONE transaction: the
  // correlationId idempotency check returns the existing session on retry, so
  // a partial state (session without its run row) could never be repaired.
  //
  // RACE: the twin check above runs outside any lock, so two concurrent starts
  // of the same work both passed it. The per-(user, scope, goal) advisory lock
  // serializes check+insert: the second waits, re-reads, and returns the
  // first's row as `deduped`. Case-insensitive, like the matcher. Skipped where
  // the matcher never dedups (a template run, or `forceCreate`).
  const lockTwins = !templateId && !params.forceCreate;
  const outcome = await db.transaction(async (tx) => {
    if (lockTwins) {
      const scopeKey = parentSessionId
        ? `parent:${parentSessionId}`
        : projectId
          ? `project:${projectId}`
          : `workspace:${workspaceId ?? ""}`;
      await tx.execute(
        drizzleSql`select pg_advisory_xact_lock(hashtext(${`session-twin|${userId}|${scopeKey}|${normalizeGoal(goal).toLowerCase()}`}))`
      );
      const raced = await findOpenSessionTwin({
        userId,
        goal,
        workspaceId,
        projectId,
        parentSessionId,
        templateId,
        database: tx as unknown as typeof db,
      });
      if (raced.exact) return { deduped: raced.exact, session: undefined };
    }

    const fields = {
      workspaceId,
      projectId,
      subjectEntityId,
      title,
      goal,
      templateId,
      playbookId: playbook?.id ?? null,
      // `focus_sessions.current_stage` is documented as "seeded from the
      // playbook's first stage on instantiation" — but this door only ever
      // wired playbookId, so a session started from a staged playbook opened
      // with a NULL stage and every stage-aware surface read it as stageless.
      // Seed it here so the column matches its contract from birth; stageless
      // playbooks (stages: []) correctly stay NULL.
      currentStage: firstStageKey(playbook?.stages),
      // `owedSince` is present IFF `owner === 'human'`, and that invariant has
      // to hold from BIRTH: a session created with an already-blocked slot
      // would otherwise carry the human's ownership with no clock, and the
      // owed feed has nothing to order or age it by.
      //
      // The SAME door the merge uses, never a second answer here — and it is
      // the whole write-authority floor, not just the clock. This was
      // `reconcileOwedSince` alone, which meant a caller could declare a slot
      // already carrying `attestedBy` (a forged human confirmation) or
      // `retiredAt` (born invisible to the owed board). The update door had
      // refused both for as long as the floor existed; this one had not.
      // The param slots are appended AFTER the floor, deliberately: they are
      // server-minted, not client-declared, and `sanitizeDeclaredOutputs`
      // exists to strip exactly the `owner`/`owedSince` a caller must not
      // forge. Running them through it would erase the ownership this door is
      // the authority on.
      expectedOutputs: [
        ...sanitizeDeclaredOutputs(expectedOutputs),
        ...paramSlots,
      ],
      criteria: sessionCriteria,
    };

    let session: typeof focusSessions.$inferSelect | undefined;
    if (adoptId) {
      // A name a person or agent chose survives adoption; a DERIVED one does
      // not (it describes the writes that opened the row, not this goal).
      const [adoptee] = await tx
        .select({
          title: focusSessions.title,
          metadata: focusSessions.metadata,
        })
        .from(focusSessions)
        .where(eq(focusSessions.id, adoptId))
        .limit(1);
      const adoptKeepsTitle = adoptee ? !canAutoRetitle(adoptee) : false;
      // ADOPT the client's auto-opened session. It stops being a write receipt
      // (the `kind` marker goes) and becomes this unit of work, bound to the
      // client; an explicit title is the agent's own (`titleSource: agent`),
      // which automation never overwrites.
      const [adopted] = await tx
        .update(focusSessions)
        .set({
          ...fields,
          // What the start did not say keeps what the auto-opened row had
          // (the workspace its first write landed in). Drizzle drops
          // `undefined` keys from a SET.
          //
          // The NAME is the exception: the row's derived name describes the
          // WRITES that opened it, and this start gives the row a different
          // goal — keeping it would leave the session called after something
          // else (live: a research session inherited "[dogfood] the Research
          // pack is enabled…" from the write that opened the receipt). With no
          // explicit title, the derived name is dropped, so lists fall back to
          // the new goal's first line until the titler names it. A title a
          // person or agent chose is never touched.
          title: title ?? (adoptKeepsTitle ? undefined : null),
          workspaceId: workspaceId ?? undefined,
          projectId: projectId ?? undefined,
          subjectEntityId: subjectEntityId ?? undefined,
          ...(playbook ? { origin: "playbook" as const } : {}),
          ...(channelId ? { channelId } : {}),
          ...(agentIds.length > 0 ? { agentIds } : {}),
          ...(correlationId ? { correlationId } : {}),
          metadata: drizzleSql`(coalesce(${focusSessions.metadata}, '{}'::jsonb) - 'kind' - 'autoOpened') || ${JSON.stringify(
            {
              clientKey,
              adoptedAt: new Date().toISOString(),
              // What this run was actually given — same key, same meaning as
              // the run funnel's (`RUN_PARAMS_METADATA_KEY`). Only when a
              // playbook resolved; an ad-hoc session has no params to store.
              ...(paramResolution
                ? { [RUN_PARAMS_METADATA_KEY]: paramResolution.declaredValues }
                : {}),
              ...(title
                ? titleSourcePatch("agent")
                : adoptKeepsTitle
                  ? {}
                  : titleSourcePatch("derived")),
            }
          )}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(focusSessions.id, adoptId), eq(focusSessions.userId, userId))
        )
        .returning();
      session = adopted;
    }
    // Not adopting — or the auto-opened row went away since the lookup.
    const adopted = !!session;
    if (!session) {
      const [inserted] = await tx
        .insert(focusSessions)
        .values({
          id: sessionId,
          ...fields,
          userId,
          correlationId: correlationId ?? null,
          // Binds the session to the calling client (write attribution); an
          // explicit title is its author's (agent or person), which automation
          // never renames. D8: conditional, so an untitled human session keeps
          // the column default.
          ...(clientKey || title || paramResolution || isProbeWriteContext()
            ? {
                metadata: stampProbeMarker({
                  ...(clientKey ? { clientKey } : {}),
                  ...(title
                    ? titleSourcePatch(agentUserId ? "agent" : "human")
                    : {}),
                  // @see the adopt branch above.
                  ...(paramResolution
                    ? {
                        [RUN_PARAMS_METADATA_KEY]:
                          paramResolution.declaredValues,
                      }
                    : {}),
                }),
              }
            : {}),
          // Typed origin (migration 0240) — stamped from what this door already
          // resolved, never re-sniffed from metadata. A session created here is
          // a playbook run exactly when `templateId` resolved to a real
          // playbook; automation-origin sessions never come through here, they
          // come through `openRunSession`. Otherwise the discriminator is
          // `agentUserId` — the SAME fact the governance membrane above already
          // used to decide whether this write needs a proposal. An agent
          // identity means an agent opened the session ("agent"); its absence
          // means a person did ("human").
          origin: playbook ? "playbook" : agentUserId ? "agent" : "human",
          channelId,
          agentIds,
          status: "active",
        })
        .returning();
      session = inserted;
    }

    // The playbook_runs ledger row (status "running") so the runs feed sees the
    // session. Mirrors run-playbook.ts's executeSingleRun insert (executor +
    // definition snapshot), minus the executor dispatch — starting a session is
    // "I'm working on this playbook", not a full executor run.
    if (playbook) {
      await tx.insert(playbookRuns).values({
        workspaceId,
        playbookId: playbook.id,
        sessionId: session.id,
        executor: playbook.executor,
        status: "running",
        createdBy: agentUserId ?? userId,
        definitionSnapshot: {
          version: playbook.version,
          goalTemplate: playbook.goalTemplate,
          stages: playbook.stages,
          params: playbook.params,
          expectedOutputs: playbook.expectedOutputs,
        },
      });
    }
    return { session: session!, adopted, deduped: undefined };
  });
  if (outcome.deduped) {
    return { status: "deduped", session: outcome.deduped, candidates: [] };
  }
  const created = outcome.session!;

  // Gate 2: always mint a work channel when the caller did not supply one
  // (parity with runPlaybook). Re-load so the returned row includes channelId.
  let sessionOut = created;
  if (!created.channelId) {
    const channelId = await ensureSessionChannel({
      sessionId: created.id,
      userId,
      workspaceId: created.workspaceId,
      goal: created.goal,
    });
    if (channelId) {
      const reloaded = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, created.id),
      });
      if (reloaded) sessionOut = reloaded;
    }
  }

  // Parent lineage: `child --spawned_from--> parent` (+ the suspend note on the
  // parent). AFTER the session exists, and never inside the transaction — a bad
  // parent handle must not roll back a legitimate session. The producer owns the
  // owner floor and the "never inherit governance" invariant.
  // Best-effort by CONTRACT, not by luck: the session row is already committed,
  // so anything thrown here would hand the caller a 500 over a session that
  // exists. But best-effort is not SILENT: both the producer's expected misses
  // and the unexpected throws land on `parentLink`, so a caller who asked for a
  // parent is told whether it got one.
  let parentLink: CreateTimeParentLink | undefined;
  if (parentSessionId) {
    try {
      const spawn = await recordSessionSpawn({
        childSessionId: sessionOut.id,
        parentSessionId,
        userId,
        workspaceId: sessionOut.workspaceId,
        suspendedIntent,
      });
      parentLink = spawn.linked
        ? {
            status: "linked",
            parentSessionId,
            suspendedIntentRecorded: spawn.suspendedIntentRecorded,
          }
        : { status: "failed", parentSessionId, reason: spawn.reason };
    } catch (err) {
      logger.warn(
        { err, sessionId: sessionOut.id, parentSessionId },
        "recordSessionSpawn failed — session kept, spawned_from edge not written"
      );
      parentLink = {
        status: "failed",
        parentSessionId,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Create-time blockers, after the row exists, each reported per id. The
  // governance judgement for an agent caller is the helper's (same as POST /links).
  const blockerLinks =
    blockedBySessionIds.length > 0
      ? await addCreateTimeBlockers({
          sessionId: sessionOut.id,
          blockerSessionIds: blockedBySessionIds,
          userId,
          agentUserId,
        })
      : undefined;

  emitHubRealtimeEvent({
    eventType: "focus_session.create.completed",
    subjectId: sessionOut.id,
    userId,
    data: {
      id: sessionOut.id,
      workspaceId: sessionOut.workspaceId,
      status: sessionOut.status,
      goal: sessionOut.goal,
      progress: sessionOut.progress,
    },
  });

  // A slot can be born blocked; the same safety net as every other block door.
  const blockGuidelines = await guidanceForBlockedSlots({
    userId,
    workspaceId: sessionOut.workspaceId ?? null,
    slots: newlyBlockedSlots(
      [],
      sessionOut.expectedOutputs as ExpectedOutput[] | null
    ),
  });

  return {
    status: "created",
    session: sessionOut,
    ...(blockGuidelines ? { blockGuidelines } : {}),
    ...(parentLink ? { parentLink } : {}),
    ...(blockerLinks ? { blockerLinks } : {}),
    ...(twinMatch.candidates.length > 0
      ? { candidates: twinMatch.candidates }
      : {}),
    ...(playbookCandidates ? { playbooks: playbookCandidates } : {}),
    ...(outcome.adopted ? { adopted: true as const } : {}),
  };
}
