/**
 * Playbook lifecycle — instantiate (config → runtime) and promote (runtime → config).
 *
 * - instantiateSession: turn a Playbook (template) into a runtime focus_session.
 *   Resolves the goalTemplate against caller params, copies expectedOutputs, and
 *   writes the `session → instantiated_from → playbook` edge.
 *
 *   TITLE vs PROMPT (they are two different strings and always were).
 *   `focus_sessions.goal` is read as a TITLE by essentially every consumer —
 *   the runs list (`services/runs/index.ts` → `flowName`), the unblock reactor
 *   (`notifications/session-unblock-reactor.ts` → `title`), diagnose
 *   (`resolve-object-kind.ts` → `displayName`), the channel namer
 *   (`ensure-session-channel.ts`), spawn-project (→ `project.name`) and the
 *   workflow place. Exactly ONE consumer read it as an INSTRUCTION: the
 *   executor dispatch in `run-playbook.ts`, which handed the rendered
 *   `goalTemplate` to the agent as its kickoff prompt. Because both roles were
 *   served by one column, every run row in every list rendered as a paragraph
 *   ("You are the CRM hygiene maintenance agent, running unattended…").
 *   Automation runs never had the problem: `automation-executor.ts` passes
 *   `automation.name` to `openRunSession`.
 *
 *   So the two strings are now stored separately:
 *     - `goal`             = the run's TITLE — `<playbook name>`, plus
 *                            ` for <subject entity title>` when a subject is
 *                            bound (`buildRunSessionTitle`).
 *     - `metadata.prompt`  = the RENDERED goalTemplate, i.e. the agent's
 *                            instruction (`RUN_PROMPT_METADATA_KEY`). Read it
 *                            with `runPromptFor(session)`, which falls back to
 *                            `goal` so sessions created before this change
 *                            still dispatch their paragraph as the prompt. The channel is left
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
  entities,
  focusSessions,
  playbooks,
} from "@synap/database";
import type { Playbook, FocusSession } from "@synap/database/schema";
import {
  buildDerivedSessionTitle,
  resolveSessionTitle,
  type SessionTitleSource,
} from "@synap-core/types/focus-sessions";
import {
  collectPlaybookCriteria,
  describeMissingParams,
  readCriteria,
  readPlaybookParams,
  validatePlaybookParams,
  type ExpectedOutput,
  type LinkInput,
  type PlaybookParam,
  type PlaybookParamTypeError,
  type PlaybookStage,
  type SessionCriterion,
} from "@synap/playbooks";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import { parseCommandTemplate } from "../../utils/command-template.js";
import { authoringMisses } from "../../utils/template-diagnostics.js";
import {
  createLinks,
  extractCapabilities,
  getLinksFor,
} from "../links/links-service.js";
import { emitSideEffects } from "@synap/events";
import { logEvent } from "../../lib/event-helpers.js";
import {
  recordConversion,
  type ConversionReceipt,
} from "../focus-sessions/session-conversion.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_PROMOTE_ACTION,
  FOCUS_SESSION_PROMOTED_EVENT_TYPE,
} from "../focus-sessions/lifecycle-events.js";

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

/**
 * The `focus_sessions.metadata` key holding a run session's rendered agent
 * prompt. The column is a free-form bag (schema/focus-sessions.ts:192).
 *
 * This module writes THREE keys: this one, {@link RUN_PARAMS_METADATA_KEY}, and
 * `titleSource`. (It said "the only key this module writes" until params became
 * enforced; that sentence was already false of `titleSource` and is now false
 * twice over.)
 */
export const RUN_PROMPT_METADATA_KEY = "prompt";

/**
 * The `focus_sessions.metadata` key holding the run's RESOLVED param answers —
 * what was actually substituted into the prompt, defaults applied and values
 * coerced to their declared types.
 *
 * It exists because the param map was previously CONSUMED AND DISCARDED: the
 * substitution happened and nothing remembered what the answers were, so
 * "what was this run given?" had no answer anywhere in the pod, and a re-run
 * could not reuse them. Stored on the metadata bag rather than a new column
 * deliberately — `focusSessions.get` already projects `metadata`, so this is
 * zero new surface: no migration, no baseline edit, no schema-coherence entry.
 */
export const RUN_PARAMS_METADATA_KEY = "params";

/**
 * A run refused because the playbook's declared params were not satisfied.
 *
 * TYPED rather than a bare `Error` so a door can render the refusal instead of
 * 500-ing on it — the shape `PromoteResult`'s typed refusal exists for, and the
 * same reason: an unanswered form is a legitimate refusal, not an invariant
 * break. `missingRequired` / `typeErrors` ride on it so the door can name the
 * fields rather than re-deriving them.
 */
export class PlaybookParamsError extends Error {
  readonly code = "PLAYBOOK_PARAMS_INVALID" as const;
  constructor(
    readonly playbookId: string,
    readonly missingRequired: PlaybookParam[],
    readonly typeErrors: PlaybookParamTypeError[]
  ) {
    super(describeParamFailure(missingRequired, typeErrors));
    this.name = "PlaybookParamsError";
  }
}

/** The refusal sentence — one place, so every door says the same thing. */
export function describeParamFailure(
  missingRequired: readonly PlaybookParam[],
  typeErrors: readonly PlaybookParamTypeError[]
): string {
  const parts: string[] = [];
  if (missingRequired.length > 0) {
    parts.push(
      `This playbook requires ${describeMissingParams(missingRequired)}. Nothing was started — supply ${missingRequired.length === 1 ? "it" : "them"} and run again.`
    );
  }
  for (const e of typeErrors) {
    parts.push(
      e.options
        ? `"${e.name}" must be one of ${e.options.map((o) => `"${o}"`).join(", ")} — got "${e.received}".`
        : `"${e.name}" must be a ${e.type}${e.fromDefault ? " (its own default is not one)" : ""} — got "${e.received}".`
    );
  }
  return parts.join(" ");
}

/** Max length of a generated run title (the column allows far more; a title should not need it). */
const RUN_TITLE_MAX = 300;

/**
 * The run session's TITLE. `<playbook name>`, plus ` for <subject title>` when
 * the run is bound to a subject entity. Pure so it is unit-testable and so the
 * propose-time path in `routers/playbooks.ts` can build the identical string
 * (its proposal `data.goal` must match what the direct path writes).
 *
 * The subject is named by its TITLE, never its id — a uuid in a list is the
 * same unreadable row this change exists to fix.
 */
export function buildRunSessionTitle(
  playbookName: string,
  subjectTitle?: string | null
): string {
  const base = playbookName.trim() || "Playbook run";
  const subject = subjectTitle?.trim();
  return (subject ? `${base} for ${subject}` : base).slice(0, RUN_TITLE_MAX);
}

/**
 * The run session's display NAME (`focus_sessions.title`) — the shared derived
 * builder, wrapped so the propose path in `routers/playbooks.ts` and the direct
 * path here build it from the same two inputs. `buildRunSessionTitle` above
 * stays the `goal` (the dedup/proposal key); this is the short name beside it.
 */
export function buildRunSessionName(
  playbookName: string,
  subjectTitle?: string | null
): string {
  return buildDerivedSessionTitle({
    kind: "run",
    name: playbookName,
    subject: subjectTitle,
  });
}

/**
 * The instruction to hand an agent for this session: the rendered prompt when
 * one was stored, else the goal. The fallback is what keeps every session
 * created BEFORE this change dispatching exactly as it did — their paragraph
 * lives in `goal` and nowhere else, so there is nothing to back-fill.
 */
export function runPromptFor(session: {
  goal: string;
  metadata?: unknown;
}): string {
  const bag = (session.metadata ?? {}) as Record<string, unknown>;
  const stored = bag[RUN_PROMPT_METADATA_KEY];
  return typeof stored === "string" && stored.trim() ? stored : session.goal;
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
   * The TRACK (`project_tracks`, 0272) this session is born inside. The caller
   * has already validated it (`resolveTrackFiling`) and set `projectId` to the
   * track's project — this funnel only persists it.
   */
  trackId?: string | null;
  /**
   * The entity this session is about (e.g. a contact, deal, or document).
   * Stored as focus_sessions.subjectEntityId — threads RunContext.subjectId
   * through from the playbook run input.
   */
  subjectId?: string | null;
  /**
   * Pre-resolved PROMPT. When set, it OVERRIDES the goalTemplate substitution —
   * used by the scheduled path, which resolves the template against the
   * automation StepContext (trigger payload + prior step outputs) before this
   * runs. Absent ⇒ the goalTemplate is substituted against `params` as before.
   * Either way the result lands on `metadata.prompt`, never on the title: this
   * is the agent's instruction, and the name is historical.
   */
  goalOverride?: string;
  /**
   * Extra session metadata to stamp at creation (merged into focus_sessions.metadata).
   * Carries the automation chain context (F2 depth floor) and the propose-only
   * governance stamp for scheduled/maintenance runs. `metadata.prompt` is always
   * added on top of whatever the caller passes and cannot be overridden here.
   */
  metadata?: Record<string, unknown>;
  /**
   * The lifecycle state the session is BORN in. Two values only, and the choice
   * is about WHO the session is waiting for:
   *
   * - `"active"` (DEFAULT — every pre-existing caller, unchanged) — the session
   *   is live now. The caller is expected to dispatch an agent / open a channel.
   * - `"scheduled"` — an APPOINTMENT. The session materialized ahead of time and
   *   is waiting for a HUMAN to open it. The caller MUST NOT kick off an agent.
   *
   * Deliberately narrowed to these two rather than the whole status union: this
   * function births sessions, and `closed`/`failed`/`stale` are exits that have
   * their own doors (`completeFocusSession`, the reaper). `scheduled` is already
   * in OPEN_SESSION_STATUSES and UPDATABLE_SESSION_STATUSES, so the human's
   * scheduled → active transition needs no new door.
   */
  status?: "active" | "scheduled";
  /**
   * WHO AUTHORED this session — `focus_sessions.origin`. Defaults to
   * `"playbook"`, which is what every pre-existing caller gets and what this
   * function has always written.
   *
   * The appointment path overrides it to `"human"` on purpose; the argument for
   * that lives at the call site (`schedule-session.ts`), because it is the kind
   * of value the next reader will assume is a bug.
   */
  origin?: "playbook" | "automation" | "agent" | "human";
  /**
   * A FIXED row id, for the approved-proposal path: the `focus_session/create`
   * executor materializes at `proposal.targetId` so any link built at propose
   * time resolves. With an id the insert is conflict-safe (a re-approve writes
   * nothing) — see {@link instantiateSessionRow}.
   */
  id?: string;
  /** The proposal chain id, stamped so a later create on the chain finds this row. */
  correlationId?: string | null;
  /**
   * The FINAL criteria list, when the caller already merged its own with the
   * playbook's (the approved-proposal path, via `mergeCriteria`). Absent ⇒ the
   * playbook's own (`collectPlaybookCriteria`).
   */
  criteria?: SessionCriterion[];
  /**
   * WHAT TO DO when the playbook declares a `required` param the caller did not
   * answer. The choice belongs to the DOOR, not to this function — it turns on
   * whether the caller has a person in front of it:
   *
   * - `"refuse"` (DEFAULT) — throw {@link PlaybookParamsError} naming the
   *   fields. For an INTERACTIVE door the form IS the gate: a run started with
   *   a hole in its instruction is not a run the person asked for.
   * - `"owe"` — start the run and file an OWED SLOT per unanswered param
   *   (`PARAM_SLOT_KIND`, `owner: "human"`, `blockedReason: "decision"`). For a
   *   HEADLESS door (MCP / CLI / cron / Raycast), which has no form: refusing
   *   would kill an unattended run over a question nobody was asked, and the
   *   pre-existing behaviour — substituting `""` and dispatching — handed the
   *   agent a mutilated instruction and called it success.
   *
   * The default is the FAIL-CLOSED one: a door that forgets to declare itself
   * refuses loudly rather than quietly running on a hole.
   *
   * TYPE ERRORS are NOT covered by this flag — they refuse on BOTH paths. A
   * mistyped value is a malformed call, not an unanswered question, and no
   * amount of human waiting fixes a caller passing a string where the playbook
   * declared a number. Filing it as an owed slot would ask a person to fix a
   * bug they cannot see.
   */
  onMissingRequired?: "refuse" | "owe";
}

/**
 * Resolve a playbook the way every SCHEDULED door must: by id, else by NAME
 * within the workspace, else a pod-wide (NULL-workspace) playbook — then assert
 * the caller's workspace may actually see it.
 *
 * EXTRACTED from `runPlaybook` (which now calls it) rather than copied, because
 * a second door onto the same config — the appointment materializer — must not
 * re-derive the by-name fallback OR the cross-workspace guard. `playbooks.id` on
 * a flow node has no FK and is editor-authored config, so that guard is the
 * write-side IDOR floor; two copies of it is exactly how one of them ends up a
 * version behind.
 *
 * Throws (never returns null) — a scheduled node naming a playbook that is gone
 * or invisible is a config error the run must fail on, not silently skip.
 */
export async function resolveRunnablePlaybook(input: {
  playbookId?: string;
  playbookName?: string;
  workspaceId: string;
}): Promise<Playbook> {
  const db = await getDb();

  let playbook = input.playbookId
    ? ((await db.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      })) as Playbook | undefined)
    : undefined;
  if (!playbook && input.playbookName) {
    playbook = ((await db.query.playbooks.findFirst({
      where: and(
        eq(playbooks.name, input.playbookName),
        eq(playbooks.workspaceId, input.workspaceId)
      ),
    })) ??
      (await db.query.playbooks.findFirst({
        where: and(
          eq(playbooks.name, input.playbookName),
          isNull(playbooks.workspaceId)
        ),
      }))) as Playbook | undefined;
  }
  if (!playbook) {
    throw new Error(
      `Playbook not found (${
        input.playbookId ?? input.playbookName ?? "no id/name given"
      })`
    );
  }

  if (playbook.workspaceId && playbook.workspaceId !== input.workspaceId) {
    throw new Error(
      // Named for THIS function, not for `runPlaybook`: since the appointment
      // producer (`materializeScheduledSession`) started sharing this door,
      // that prefix sent whoever read the log looking at the wrong caller.
      `resolveRunnablePlaybook: playbook ${playbook.id} not visible in workspace ${input.workspaceId}`
    );
  }

  return playbook;
}

/**
 * Instantiate a runtime focus_session from a playbook. Caller MUST gate first.
 */
export async function instantiateSession(
  input: InstantiateInput
): Promise<FocusSession> {
  const session = await instantiateSessionRow(input);
  if (!session) {
    // Only reachable with a caller-fixed `id` that already exists.
    throw new Error(`Focus session ${input.id} already exists`);
  }
  return session;
}

/**
 * {@link instantiateSession}'s body, returning `null` instead of throwing when
 * a caller-fixed `id` is already taken (the insert then writes nothing — no
 * row, no edges). The approved-proposal executor calls this so a re-approve is
 * a receipt of ZERO rows rather than a crash; every other caller goes through
 * `instantiateSession`, whose ids are always fresh.
 */
export async function instantiateSessionRow(
  input: InstantiateInput
): Promise<FocusSession | null> {
  const db = await getDb();
  const playbook = await db.query.playbooks.findFirst({
    where: eq(playbooks.id, input.playbookId),
  });
  if (!playbook) {
    throw new Error(`Playbook ${input.playbookId} not found`);
  }

  // PARAMS — validated HERE and nowhere else. This function is the single
  // funnel behind all six run doors (playbooks.run, playbooks.instantiate, the
  // Hub run door, MCP synap_run_playbook, the cron path and the
  // approved-proposal path); six doors each validating is how drift starts.
  //
  // Until this existed the declaration was decorative: nothing read `required`,
  // `default` or `type` on any run path, so a missing required param rendered
  // as `""` and a default never reached the prompt at all.
  const paramResolution = validatePlaybookParams(
    readPlaybookParams(playbook.params),
    input.params
  );
  const onMissingRequired = input.onMissingRequired ?? "refuse";
  if (
    paramResolution.typeErrors.length > 0 ||
    (paramResolution.missingRequired.length > 0 &&
      onMissingRequired === "refuse")
  ) {
    throw new PlaybookParamsError(
      playbook.id,
      // Only the half this path is actually refusing over: on the `owe` path a
      // missing param is not a refusal, so naming it in the type-error message
      // would report a failure that is about to be filed as a slot instead.
      onMissingRequired === "refuse" ? paramResolution.missingRequired : [],
      paramResolution.typeErrors
    );
  }

  // The rendered goalTemplate is the agent's PROMPT, not the row's title. The
  // scheduled path's `goalOverride` (resolved against the automation
  // StepContext) is the same thing — an instruction — so it overrides the
  // prompt, never the title.
  //
  // Substituted against the RESOLVED values, so a declared `default` finally
  // reaches the agent's instruction.
  const prompt =
    input.goalOverride ??
    resolveGoal(playbook.goalTemplate, paramResolution.values, playbook.id);

  // Title = playbook name + the bound subject's own title. Read the entity here
  // rather than trusting a caller-passed name: `instantiateSession` has three
  // callers and only one of them resolves the subject.
  let subjectTitle: string | null = null;
  if (input.subjectId) {
    const subject = await db.query.entities.findFirst({
      columns: { title: true },
      where: eq(entities.id, input.subjectId),
    });
    subjectTitle = subject?.title ?? null;
  }
  const goal = buildRunSessionTitle(playbook.name, subjectTitle);
  // The display NAME. `goal` above stays exactly as it was — it is the
  // dedup/proposal key other doors compare on — and the short name is written
  // beside it, marked `derived` so the background titler may improve it.
  const title = buildRunSessionName(playbook.name, subjectTitle);
  const declaredOutputs = (playbook.expectedOutputs as ExpectedOutput[]) ?? [];
  // On the `owe` path, every unanswered required param becomes an owed slot the
  // run carries from birth. `owedSince` is stamped here because the invariant
  // is exact — it is present IFF `owner === 'human'` — and the needs-you feed
  // has nothing to order or age the row by without it.
  const owedAt = new Date().toISOString();
  const paramSlots: ExpectedOutput[] =
    onMissingRequired === "owe"
      ? paramResolution.missingRequired.map((p) => ({
          kind: PARAM_SLOT_KIND,
          label: `Answer: ${p.label?.trim() || p.name}`,
          owner: "human" as const,
          // `decision` is the honest blocker: there is nothing to BUILD to
          // remove it (no credential to mint, no rule to write, no tool to
          // install) — a person has to choose a value. See BLOCKED_REASONS.
          blockedReason: "decision" as const,
          why: `"${playbook.name}" needs a value for "${p.label?.trim() || p.name}"${
            p.options?.length
              ? ` (one of ${p.options.map((o) => `"${o}"`).join(", ")})`
              : ` (${p.type})`
          }. Nobody supplied it, so the run started without it.`,
          owedSince: owedAt,
        }))
      : [];
  const expectedOutputs = [...declaredOutputs, ...paramSlots];
  // Seed the active stage from the playbook's first stage (null when stageless,
  // so a no-stage playbook stays progress-only — currentStage never NOT NULL).
  const stages = (playbook.stages as PlaybookStage[]) ?? [];
  const currentStage = stages[0]?.key ?? null;

  const insert = db.insert(focusSessions).values({
    ...(input.id ? { id: input.id } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    workspaceId: input.workspaceId,
    userId: input.userId,
    title,
    goal,
    playbookId: playbook.id,
    // Typed origin (migration 0240) — instantiating from a playbook IS the
    // definition of a playbook-origin session; the caller knows it without
    // inspecting metadata.
    origin: input.origin ?? "playbook",
    projectId: input.projectId ?? null,
    trackId: input.trackId ?? null,
    subjectEntityId: input.subjectId ?? null,
    expectedOutputs,
    // Playbook-level + every stage's criteria, stageKey stamped — the one
    // copy rule. Written in this body, so the approved-proposal path grades
    // against the same list as a direct instantiate.
    criteria: input.criteria ?? collectPlaybookCriteria(playbook),
    currentStage,
    channelId: input.channelId ?? null,
    agentIds: input.agentIds ?? [],
    status: input.status ?? "active",
    metadata: {
      ...(input.metadata ?? {}),
      [RUN_PROMPT_METADATA_KEY]: prompt,
      // The answers the run was actually given — see RUN_PARAMS_METADATA_KEY.
      // Written unconditionally (an empty object for a param-less playbook) so
      // a reader can tell "this run was given nothing" from "this row predates
      // the field", which absence alone cannot say.
      [RUN_PARAMS_METADATA_KEY]: paramResolution.declaredValues,
      titleSource: "derived" satisfies SessionTitleSource,
    },
  });
  const [session] = input.id
    ? await insert.onConflictDoNothing().returning()
    : await insert.returning();
  if (!session) return null;

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
  /** Optional name for the new playbook (defaults to the session's display name). */
  name?: string;
  description?: string;
  /** Agent attribution, when an agent's approved proposal is materializing. */
  agentUserId?: string | null;
}

/**
 * The promote outcome.
 *
 * The project-scope guard used to `throw` a bare string, which every caller then
 * surfaced as a 500 over a perfectly legitimate refusal. It is now a TYPED
 * refusal the caller can render; a missing session still throws, because that is
 * an invariant break (the caller loaded it a moment earlier), not a refusal.
 */
export type PromoteResult =
  | {
      status: "promoted";
      playbook: Playbook;
      /** True when a same-name playbook already existed and was REUSED. */
      reused: boolean;
      receipt: ConversionReceipt;
    }
  | { status: "refused"; reason: "project_scoped_session"; message: string };

/**
 * Promote a validated session into a reusable Playbook. Caller MUST gate first.
 */
export async function promoteSessionToPlaybook(
  input: PromoteInput
): Promise<PromoteResult> {
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
    return {
      status: "refused",
      reason: "project_scoped_session",
      message:
        "Project-scoped sessions (no workspace) cannot be promoted to a playbook yet.",
    };
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

  // The session's NAME (its title, else the goal's first line) — not the
  // goal clipped mid-paragraph.
  const name =
    input.name ??
    (resolveSessionTitle(session, { maxLength: 200 }) || "Playbook");
  // The new playbook's TEMPLATE is the session's instruction, not its title —
  // promoting a run session whose goal is now "<playbook> for Acme Corp" must
  // not hand the next agent that label as its whole prompt.
  const goalTemplate = runPromptFor(session);
  // Honest subject: copy the session's subject entity kind when it has one,
  // leave null when it doesn't. `entities.type` is the profile slug.
  let subjectProfile: { profileSlug: string } | null = null;
  if (session.subjectEntityId) {
    const subject = await db.query.entities.findFirst({
      columns: { type: true },
      where: eq(entities.id, session.subjectEntityId),
    });
    const slug = subject?.type?.trim();
    if (slug) subjectProfile = { profileSlug: slug };
  }
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
        goalTemplate,
        expectedOutputs: (session.expectedOutputs as ExpectedOutput[]) ?? [],
        // The session's criteria become the playbook's own — STRUCTURE only
        // (key/statement/required/check). Evaluations are this run's verdicts,
        // not the template's; `stageKey` is dropped because promote copies no
        // stages, so a stage-bound criterion would point at nothing.
        criteria: readCriteria(session.criteria).map(
          ({ stageKey: _stageKey, ...structure }) => structure
        ),
        executor: "is-agent",
        status: "draft",
        subjectProfile,
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

  // Rename the source + stamp the receipt through the ONE conversion recorder
  // (shared with spawn-project, so the two verbs cannot disagree about the
  // shape). Prior art: Linear retitles the issue it converted so the list it
  // still lives in says what happened to it.
  const receipt = await recordConversion({
    session,
    kind: "playbook",
    createdId: playbook.id,
    createdName: playbook.name,
    userId: input.userId,
  });

  // Promote emitted NOTHING before this wave: no history row, no reactor hop,
  // so no automation could fire on a promotion and no reader could see one. Both
  // halves now, for the reason `close-event.ts` spells out.
  const eventData = {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    userId: input.userId,
    playbookId: playbook.id,
    playbookName: playbook.name,
    reused,
    renamedFrom: receipt.renamedFrom,
    goal: receipt.renamedTo,
  };
  await logEvent(input.userId, FOCUS_SESSION_PROMOTED_EVENT_TYPE, eventData, {
    subjectId: session.id,
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    source: input.agentUserId ? "intelligence" : "api",
    ...(input.agentUserId
      ? { metadata: { agentUserId: input.agentUserId } }
      : {}),
  });
  await emitSideEffects({
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    action: FOCUS_SESSION_PROMOTE_ACTION,
    subjectId: session.id,
    userId: input.userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    data: eventData,
  });

  return { status: "promoted", playbook, reused, receipt };
}
