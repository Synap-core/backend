/**
 * Capability execution — ONE shared core for "launch a registered capability".
 *
 * Resolves a capability VERB (verbId = backing skill name) or a skillId to its
 * skill, runs `gateCapabilityExecution`, and on `run` delegates to the IS sandbox
 * via `executeSkillViaIS`. Returns a discriminated result the callers map to their
 * own shape:
 *   - Hub REST `POST /capabilities/execute` → HTTP 200/202/403/404
 *   - MCP tool `run_capability` → a text result
 *
 * Identity: OPERATOR/owner run (no agentUserId) — the bearer who applied the
 * capability owns the skill → owner-bypass runs it; a non-owner/unapproved skill
 * routes to `propose`. (Agent-initiated runs flow through the IS agent loop, not
 * this door.) A DRAFT skill is denied for everyone (approval gate) — enable it
 * first via `POST /skills/:id/approve`.
 *
 * ACK INTEGRITY (C1): the result carries `ackState` (`applied` for a run, `proposed`
 * for a queued run, `duplicate-ignored` for an idempotent replay) so a caller can
 * tell a fresh run from a governed queue from a re-submit. BOTH irreversible paths
 * are now at-most-once:
 *   - the PROPOSAL path via `dispatchExternalOnce` (CAS on
 *     `proposals.external_dispatched_at`) at approval;
 *   - the DIRECT-run path (owner/granted, no proposal) via a `capability_run_receipts`
 *     CAS claim (migration 0219) — an EXTERNAL-send verb claims a receipt keyed on
 *     the idempotency key BEFORE the effect, so a client-perceived-failure retry
 *     replays the stored result instead of firing a second real send. The failure
 *     policy mirrors dispatchExternalOnce (release on definite-not-delivered,
 *     keep-claim on an ambiguous throw). READ-only verbs AND local builtin writes
 *     skip the receipt (a repeated read is harmless; a local write must not be
 *     content-hash-collapsed — see `capabilityVerbHasExternalEffect`). An explicit
 *     idempotency key claims STRICTLY (permanent); a derived content-hash key
 *     claims WINDOWED (so a later identical run is not blocked forever).
 */

import {
  db,
  skills,
  eq,
  and,
  desc,
  knowledgeRepository,
  capabilityRunReceipts,
} from "@synap/database";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

import { resolveWriteIdempotencyKey } from "../../utils/write-door-idempotency.js";

import { emitAiDecision } from "../../utils/ai-feedback-events.js";
import { gateCapabilityExecution } from "./gate-capability-execution.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";
import { runSkillInSandbox } from "../skills/run-skill-in-sandbox.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";
import type {
  ConnectionSelector,
  FailureErrorClass,
} from "../../connectors/external-dispatch.js";
import { createPendingProposal } from "../../utils/permission-check.js";
import { openLink } from "../../utils/deep-links.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { capErrorMessage } from "../connection-health/notify-connector-unhealthy.js";
import type { WriteAckState } from "../../utils/write-door-idempotency.js";

const logger = createLogger({ module: "execute-capability" });

export type ExecuteCapabilityResult =
  | {
      kind: "run";
      skillId: string;
      result: unknown;
      ackState: WriteAckState;
      /**
       * Observability handle for a DIRECT run (owner-bypass / read-only builtin /
       * governance-auto-granted agent). The run emits a `capability_run`
       * ai_decision event keyed by this correlationId — the SAME join key the
       * `capability.run` approve-executor stamps — so a direct run is listable via
       * `listCapabilityRuns`, has a getRun timeline, and is `diagnose(id)`-able.
       * Best-effort: absent only if the (swallowed) emit could not produce one.
       */
      correlationId?: string;
    }
  | { kind: "dry-run"; skillId: string }
  | {
      kind: "proposed";
      proposalId: string;
      reviewUrl: string;
      ackState: WriteAckState;
    }
  | { kind: "deny"; reason: string }
  // A run that REACHED its handler and FAILED (a code skill's sandbox returned
  // success:false, or a declarative provider verb returned an error envelope).
  // The ONE failure channel: callers must NOT dig a success:false envelope out of
  // a `kind:"run"` result — a failed run is `kind:"error"`, never `kind:"run"`.
  // P1: `errorClass`/`providerRef` ride ALONGSIDE the human message (set when the
  // failure came from a provider dispatch; absent for sandbox/config failures).
  | {
      kind: "error";
      message: string;
      errorClass?: FailureErrorClass;
      providerRef?: string;
    }
  | { kind: "not_found"; message: string };

export async function executeCapability(input: {
  /** Capability verb = backing skill NAME. One of verbId/skillId required. */
  verbId?: string;
  /** Direct skill id (alternative to verbId). */
  skillId?: string;
  /** Inputs passed to the skill sandbox (`args`). */
  parameters?: Record<string, unknown>;
  /** Acting workspace — OPTIONAL lens that narrows the skill lookup + the gate.
   * `null` = pod-wide run; a `propose` then routes to the user's pod-wide queue. */
  workspaceId: string | null;
  /** The acting operator (bearer's user). */
  userId: string;
  /**
   * The acting AGENT (agent-user id) when the call originates from an agent — the
   * MCP `run_capability` tool or a Hub agent key — else null for a genuine
   * operator run. Threaded to the gate: an agent WRITE verb without an active
   * grant routes to a PROPOSAL (never auto-runs under the operator's identity);
   * READ-only verbs auto-run regardless (the readOnly short-circuit precedes the
   * grant check). This is what makes "AI mutations → checkPermissionOrPropose"
   * hold at this door instead of laundering the agent into the operator.
   */
  agentUserId?: string | null;
  /** Runtime 1-of-N connection selector (Wave 4) — passed to a provider verb. */
  connectionSelector?: ConnectionSelector | null;
  /**
   * Callers with NO interactive review surface (e.g. the automation executor)
   * set this so a `propose` verdict returns a plain `deny` INSTEAD of persisting
   * a proposal row — otherwise a recurring automation with an unapproved verb
   * would spawn a duplicate proposal every tick. Approve the skill to run it
   * unattended.
   */
  suppressProposal?: boolean;
  /**
   * Optional caller idempotency key (C1). Correlates a logical invocation across
   * retries on BOTH paths: it is stamped onto a `capability.run` proposal (approved
   * run + retry), AND it keys the DIRECT-run path's `capability_run_receipts` CAS
   * claim so an owner/granted WRITE verb that performs an external send is
   * at-most-once — a retry replays the stored result instead of double-sending.
   * When omitted, a stable content hash over (verb/skill + params + user +
   * workspace + connection) is derived, so an unkeyed retry still collides; a
   * genuinely different payload gets a different key. Pass an explicit key (or vary
   * the params) when a byte-identical run within ~10 minutes is a real second intent.
   */
  idempotencyKey?: string;
}): Promise<ExecuteCapabilityResult> {
  const { verbId, skillId, parameters, workspaceId, userId } = input;
  if (!verbId && !skillId) {
    return {
      kind: "not_found",
      message: "Either verbId or skillId is required",
    };
  }

  // Resolve the backing skill through the SAME three-tier visibility contract as
  // the skills catalog. In particular, a direct `skillId` is not an authority:
  // it must still belong to the caller's pod/user/workspace lens and be active.
  // This protects every caller of this shared core (Hub REST, MCP, Raycast).
  const [skillRow] = await db
    .select({
      id: skills.id,
      name: skills.name,
      approved: skills.approved,
      userId: skills.userId,
      kind: skills.kind,
      providerSpec: skills.providerSpec,
    })
    .from(skills)
    .where(
      and(
        visibleSkillsWhere(userId, workspaceId ?? undefined),
        eq(skills.status, "active"),
        skillId ? eq(skills.id, skillId) : eq(skills.name, verbId!)
      )
    )
    // Deterministic resolution when a verb NAME has duplicates (e.g. a stale
    // re-installed capability): prefer an approved skill, then the most recently
    // updated — so a fresh re-apply wins over a stale shadow instead of a random
    // `.limit(1)`. (The real fix for duplicates is de-dup; this hardens the door.)
    .orderBy(desc(skills.approved), desc(skills.updatedAt))
    .limit(1);

  if (!skillRow) {
    return {
      kind: "not_found",
      message: `Capability ${
        skillId ? `skill "${skillId}"` : `verb "${verbId}"`
      } not found in this workspace. Search what's available with list_capabilities({query: "…"}); if nothing matches, tell the user exactly what's missing — never fabricate a result.`,
    };
  }

  // A read-only BUILTIN verb is not a mutation — mark the gate `readOnly` so it
  // auto-runs (no grant, no propose) once it clears the approval gate; its scope
  // is enforced by the access layer inside the handler, NOT by the gate. Mirrors
  // execute-provider-verb's `isReadMethod → alreadyApproved:true`. WRITE builtins
  // (and every non-builtin) leave this false and flow through the full ladder.
  const readOnly =
    skillRow.kind === "builtin" && READ_ONLY_BUILTIN_VERBS.has(skillRow.name);

  const decision = await gateCapabilityExecution({
    capabilityKind: "skill",
    capabilityId: skillRow.id,
    skill: skillRow,
    actorUserId: userId,
    agentUserId: input.agentUserId ?? null,
    workspaceId,
    issuer: "hub.capabilities-execute",
    readOnly,
  });

  if (decision.decision === "deny") {
    return { kind: "deny", reason: decision.reason };
  }
  if (decision.decision === "dry-run") {
    return { kind: "dry-run", skillId: skillRow.id };
  }
  if (decision.decision === "propose") {
    if (input.suppressProposal) {
      return {
        kind: "deny",
        reason:
          "Capability requires approval and no review surface is available (unattended run); approve the skill to run it.",
      };
    }
    const proposal = await createPendingProposal({
      userId,
      workspaceId,
      // Attribute the proposal to the acting agent so its OWNER can approve it
      // (computeCanReviewApproval resolves agentUserId -> users.createdByUserId).
      // Without this the row stored agentUserId:null and only admins could review.
      agentUserId: input.agentUserId ?? undefined,
      targetType: "capability",
      targetId: skillRow.id,
      proposalType: "capability.run",
      data: {
        skillId: skillRow.id,
        verbId: verbId ?? null,
        parameters: parameters ?? {},
        workspaceId,
        // Carry the 1-of-N connection selector so an APPROVED run resolves the
        // same connection the original call intended (see runResolvedSkill).
        connectionSelector: input.connectionSelector ?? null,
        // C1: correlate an approved run + any retry to one logical invocation.
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
      notificationDescription: `Run capability ${verbId ?? skillRow.id}`,
    });
    // Every other governed write hands the caller a clickable review link —
    // this door must too (IS/MCP tools surface it to the user).
    return {
      kind: "proposed",
      proposalId: proposal.id,
      reviewUrl: openLink(proposal.id),
      ackState: "proposed",
    };
  }

  // decision === "run" → execute through the SINGLE post-gate runner (shared with
  // the capability.run proposal replay), so the door and an approved proposal can
  // never diverge on kind-routing. Stamp `ackState: "applied"` on a successful run
  // (deny/not_found carry no ack — they didn't write).
  //
  // AT-MOST-ONCE (0219): a WRITE/external verb on the DIRECT path performs an
  // irreversible send with no proposal to carry a `dispatchExternalOnce` claim, so
  // a client-perceived-failure RETRY would double-send. Route it through the
  // receipt-guarded runner (CAS-claim → run → store/replay). Reads AND local
  // builtin writes carry no external-double-send risk — and content-hash
  // windowing must NOT collapse legit duplicate local writes — so they run
  // unguarded through the shared path below.
  if (capabilityVerbHasExternalEffect(skillRow)) {
    return runDirectWriteVerbOnce({
      skillRow,
      parameters,
      verbId: verbId ?? null,
      userId,
      workspaceId,
      connectionSelector: input.connectionSelector ?? null,
      agentUserId: input.agentUserId ?? null,
      idempotencyKey: input.idempotencyKey,
    });
  }

  const ran = await runResolvedSkill(skillRow, parameters, {
    userId,
    workspaceId,
    connectionSelector: input.connectionSelector ?? null,
    agentUserId: input.agentUserId ?? null,
  });
  if (ran.kind !== "run") return ran;

  // OBSERVABILITY (additive, best-effort). Until now a direct run returned
  // INLINE with no correlationId / event / recall — invisible to the runs feed
  // and to `diagnose` ("Run not found"). Mirror the `capability.run`
  // approve-executor VERBATIM: stamp a correlationId, emit its ONE
  // `capability_run` ai_decision timeline entry keyed by it, and deposit the
  // result into recall. A telemetry failure NEVER breaks the already-executed
  // run — it only drops the handle.
  const correlationId = randomUUID();
  await recordDirectCapabilityRun({
    correlationId,
    userId,
    workspaceId,
    skillId: skillRow.id,
    verbId: verbId ?? null,
    runResult: ran.result,
  });
  return { ...ran, ackState: "applied" as const, correlationId };
}

/**
 * Does a DIRECT-run of this verb fire an irreversible EXTERNAL effect (a send to
 * a third party / provider) that needs the at-most-once receipt? Only external
 * sends do.
 *
 * A LOCAL builtin write (entity.create, feed.post, graph.link, document.*, …) is
 * deliberately EXCLUDED: none of the builtins send to a third party, and its
 * retry produces at worst a recoverable duplicate — whereas the receipt's
 * WINDOWED content-hash key would silently COLLAPSE two legitimately-identical
 * local writes into one (e.g. two tasks both titled "Follow up with Acme" within
 * 10 min → only one created, the second reporting the first's id). That silent
 * data-loss is worse than the duplicate it was guarding against. Local-write
 * idempotency, if ever wanted, belongs in an explicit-key mechanism, not this
 * external-send guard. Fail-CLOSED — an unknown/absent provider method is treated
 * as external (a redundant receipt is far cheaper than a double-send).
 *   - builtin      → local hub op, never an external send → false.
 *   - declarative  → external iff its provider method is NOT GET/HEAD (the SAME
 *                    `isReadMethod` notion execute-provider-verb gates on).
 *   - code / other → may send externally → true.
 */
export function capabilityVerbHasExternalEffect(
  skill: Pick<ResolvedSkillRow, "kind" | "name" | "providerSpec">
): boolean {
  if (skill.kind === "builtin") {
    return false;
  }
  if (skill.kind === "declarative") {
    const spec = skill.providerSpec;
    // GraphQL keys read/write off its OPERATION (all GraphQL is a POST), not the
    // HTTP method — the SAME notion `execute-provider-verb`'s `isReadMethod`
    // uses; both sites MUST agree. `operation:"query"`=read; default "mutation"
    // (fail-closed) = external write.
    if (spec?.transport === "graphql") {
      return (spec.graphql?.operation ?? "mutation") !== "query";
    }
    return !/^(GET|HEAD)$/i.test(String(spec?.method ?? ""));
  }
  return true;
}

/**
 * Run a DIRECT WRITE/external verb AT MOST ONCE. The direct-path analog of the
 * proposal path's `dispatchExternalOnce`, using a `capability_run_receipts` CAS
 * claim instead of the `proposals.external_dispatched_at` column:
 *
 *   1. CLAIM — INSERT a receipt keyed on (idempotency_key, ~10-min dedup bucket)
 *      via ON CONFLICT DO NOTHING. Won the claim → run. Lost it → a prior receipt
 *      exists in this window: replay its stored result (COMPLETED → duplicate-
 *      ignored) or refuse (still CLAIMED → an in-flight/ambiguous send; never
 *      re-run — mirrors dispatchExternalOnce's CONFLICT).
 *   2. RUN — execute via the shared post-gate `runResolvedSkill`.
 *   3. RESOLVE — success: mark the receipt COMPLETED + store the result (a retry
 *      replays it). Definite-not-delivered (error/deny/not_found): RELEASE the
 *      claim so a retry re-runs. Ambiguous THROW (the effect may have reached the
 *      far side): KEEP the claim (no resend) + rethrow.
 *
 * BEST-EFFORT: an idempotency-store hiccup DEGRADES to a plain guarded-less run —
 * it must never block a real run. Observability (recordDirectCapabilityRun) is
 * emitted on delivery exactly as the read/unguarded path does.
 */
async function runDirectWriteVerbOnce(opts: {
  skillRow: ResolvedSkillRow;
  parameters?: Record<string, unknown>;
  verbId: string | null;
  userId: string;
  workspaceId: string | null;
  connectionSelector: ConnectionSelector | null;
  agentUserId: string | null;
  idempotencyKey?: string;
}): Promise<ExecuteCapabilityResult> {
  const key = resolveWriteIdempotencyKey(
    opts.idempotencyKey,
    "capability.run.direct",
    {
      verbId: opts.verbId,
      skillId: opts.skillRow.id,
      parameters: opts.parameters,
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      connectionSelector: opts.connectionSelector,
    }
  );
  // An EXPLICIT idempotency key is a caller's declaration that "this is one
  // operation, never run it twice" (Stripe-style) — so it gets a STRICT,
  // permanent claim (dedupBucket pinned to 0, making `(key, 0)` a forever-unique
  // row), immune to the bucket-boundary straddle that would otherwise let a
  // retry seconds after a window rollover double-send. A DERIVED content-hash key
  // (no explicit key) keeps the DB-default WINDOWED bucket, so a genuinely
  // repeated identical run in a later window is not blocked forever.
  const hasExplicitKey = opts.idempotencyKey != null;
  const correlationId = randomUUID();

  // ── 1. CLAIM (best-effort — a store hiccup degrades to an unguarded run) ──────
  let claimId: string | null = null;
  try {
    const [claim] = await db
      .insert(capabilityRunReceipts)
      .values({
        idempotencyKey: key,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        skillId: opts.skillRow.id,
        verbId: opts.verbId,
        correlationId,
        status: "claimed",
        ...(hasExplicitKey ? { dedupBucket: 0 } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: capabilityRunReceipts.id });

    if (claim) {
      claimId = claim.id;
    } else {
      // Lost the claim → a receipt already exists in this window. The conflicting
      // row is the newest for this key, so read that.
      const [prior] = await db
        .select({
          status: capabilityRunReceipts.status,
          result: capabilityRunReceipts.result,
          correlationId: capabilityRunReceipts.correlationId,
          skillId: capabilityRunReceipts.skillId,
        })
        .from(capabilityRunReceipts)
        .where(eq(capabilityRunReceipts.idempotencyKey, key))
        .orderBy(desc(capabilityRunReceipts.createdAt))
        .limit(1);

      if (prior?.status === "completed") {
        // Idempotent replay — the effect already fired once; return its result
        // with NO second side effect. The receipt carries the same correlationId
        // so the caller lands on the same run handle (like a first run).
        return {
          kind: "run",
          skillId: prior.skillId,
          result: prior.result,
          ackState: "duplicate-ignored",
          ...(prior.correlationId
            ? { correlationId: prior.correlationId }
            : {}),
        };
      }
      if (prior) {
        // A claim exists but is not COMPLETED: a concurrent send is in flight, or
        // a prior attempt died mid-send (ambiguous). At-most-once: do NOT re-run —
        // refuse honestly rather than risk a double-send. Mirrors
        // dispatchExternalOnce's CONFLICT. A retry after the window (a new bucket)
        // re-runs cleanly.
        return {
          kind: "error",
          message:
            "This capability run is already in progress — nothing was re-sent. Retry in a moment if it did not complete.",
        };
      }
      // No prior row (a rare race with a just-released claim): degrade to an
      // unguarded run rather than dead-end a legitimate call.
    }
  } catch (err) {
    logger.warn(
      { err, skillId: opts.skillRow.id },
      "capability direct-run receipt claim failed (running unguarded)"
    );
  }

  // ── 2. RUN ────────────────────────────────────────────────────────────────────
  let ran: Awaited<ReturnType<typeof runResolvedSkill>>;
  try {
    ran = await runResolvedSkill(opts.skillRow, opts.parameters, {
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      connectionSelector: opts.connectionSelector,
      agentUserId: opts.agentUserId,
    });
  } catch (err) {
    // Ambiguous throw (the side effect may have reached the far side): KEEP the
    // claim so a retry within the window does NOT re-send. Rethrow.
    throw err;
  }

  // ── 3. RESOLVE ──────────────────────────────────────────────────────────────
  if (ran.kind !== "run") {
    // DEFINITE not-delivered (the handler refused / a provider error envelope):
    // RELEASE the claim so a retry re-runs cleanly. Mirrors dispatchExternalOnce's
    // { delivered: false } release. Best-effort.
    if (claimId) {
      try {
        await db
          .delete(capabilityRunReceipts)
          .where(eq(capabilityRunReceipts.id, claimId));
      } catch (err) {
        logger.warn(
          { err, skillId: opts.skillRow.id, claimId },
          "capability direct-run receipt release failed (retry may be blocked until the window rolls)"
        );
      }
    }
    return ran;
  }

  // Delivered → mark the receipt COMPLETED + store the result so a retry replays
  // it instead of re-sending. Best-effort: a stamp failure leaves the receipt
  // CLAIMED (a retry then refuses until the window rolls — safe, never a resend).
  if (claimId) {
    try {
      await db
        .update(capabilityRunReceipts)
        .set({
          status: "completed",
          result: ran.result ?? null,
          completedAt: new Date(),
        })
        .where(eq(capabilityRunReceipts.id, claimId));
    } catch (err) {
      logger.warn(
        { err, skillId: opts.skillRow.id, claimId },
        "capability direct-run receipt completion stamp failed (run kept delivered)"
      );
    }
  }

  await recordDirectCapabilityRun({
    correlationId,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    skillId: opts.skillRow.id,
    verbId: opts.verbId,
    runResult: ran.result,
  });
  return { ...ran, ackState: "applied" as const, correlationId };
}

/**
 * Cap a direct run's result before it rides inside the `capability_run` event's
 * `data` (getRun reads it back for the run's `outputSummary`). A provider list /
 * full API envelope can be arbitrarily large; bound it so one event never bloats.
 */
function boundEventRunResult(runResult: unknown): unknown {
  if (runResult === undefined || runResult === null) return null;
  const json = JSON.stringify(runResult);
  if (json.length <= 8000) return runResult;
  return { truncated: true, preview: json.slice(0, 8000) };
}

/**
 * Make a DIRECT capability run observable — the SAME two side-effects the
 * `capability.run` approve-executor performs (emit + recall deposit), so the
 * direct-run and proposed→approved paths converge on ONE observability shape.
 * The event's `data.kind`/`action` are `"capability_run"` (verbatim the
 * approve-executor's) so the runs read-layer catches BOTH from one filter.
 * Best-effort throughout: never throws — the run already succeeded.
 */
async function recordDirectCapabilityRun(opts: {
  correlationId: string;
  userId: string;
  workspaceId: string | null;
  skillId: string;
  verbId: string | null;
  runResult: unknown;
}): Promise<void> {
  const label = opts.verbId ?? opts.skillId;

  // emitAiDecision is itself best-effort (swallows + logs, never throws), so the
  // event is safe to await directly.
  await emitAiDecision({
    action: "capability_run",
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    correlationId: opts.correlationId,
    data: {
      kind: "capability_run",
      skillId: opts.skillId,
      verbId: opts.verbId,
      // A direct run has NO proposal to carry the output — stash a bounded copy
      // on the event so getRun's "capability" branch can surface it.
      runResult: boundEventRunResult(opts.runResult),
    },
  });

  // Recall deposit — the SAME door `remember_fact` uses (knowledgeRepository
  // .saveFact), so a direct run's result is recallable like every other fact.
  // Best-effort: an embedding/index failure must not undo the delivered run.
  try {
    const fact = `Ran capability "${label}" → ${JSON.stringify(opts.runResult).slice(0, 1000)}`;
    let embedding: number[];
    try {
      const { generateEmbedding } = await import("@synap/ai-embeddings");
      embedding = await generateEmbedding(fact);
    } catch {
      embedding = new Array(1536).fill(0);
    }
    await knowledgeRepository.saveFact({
      userId: opts.userId,
      fact,
      confidence: 0.9,
      embedding,
    });
  } catch (err) {
    logger.warn(
      { err, skillId: opts.skillId, correlationId: opts.correlationId },
      "direct capability run: recall deposit failed (run kept delivered)"
    );
  }
}

/** The gate-approved skill row shape `runResolvedSkill` operates on. */
export interface ResolvedSkillRow {
  id: string;
  name: string;
  kind: string | null;
  providerSpec: Parameters<typeof executeProviderVerb>[0] | null;
}

/**
 * The SINGLE post-gate execution branch: given a gate-approved skill row, run it
 * by kind. Called by BOTH executeCapability (the door) AND the `capability.run`
 * proposal replay (proposals/approve-executors), so an approved proposal can
 * never diverge from the door's routing — the kind-branch has exactly one home.
 *   TIER 0 builtin      → governed in-process handler (BUILTIN_VERBS)
 *   TIER 1 declarative  → executeProviderVerb (connection-aware, in-process)
 *   TIER 2 code/instr.  → the IS isolate
 */
export async function runResolvedSkill(
  skill: ResolvedSkillRow,
  parameters: Record<string, unknown> | undefined,
  ctx: {
    userId: string;
    workspaceId: string | null;
    connectionSelector?: ConnectionSelector | null;
    /**
     * The acting agent, when the caller is an agent (null/absent = operator).
     * Threaded to builtin handlers so agent-aware verbs (market.install's
     * always-propose rule) can't be laundered into operator runs by an
     * explicit auto exec-mode grant on the verb itself.
     */
    agentUserId?: string | null;
  }
): Promise<
  | { kind: "run"; skillId: string; result: unknown }
  | {
      kind: "error";
      message: string;
      errorClass?: FailureErrorClass;
      providerRef?: string;
    }
  | { kind: "not_found"; message: string }
  | { kind: "deny"; reason: string }
> {
  if (skill.kind === "builtin") {
    const handler = BUILTIN_VERBS[skill.name];
    if (!handler) {
      return {
        kind: "not_found",
        message: `No builtin handler registered for verb "${skill.name}".`,
      };
    }
    const result = await handler(parameters ?? {}, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      agentUserId: ctx.agentUserId ?? null,
    });
    return { kind: "run", skillId: skill.id, result };
  }

  if (skill.kind === "declarative") {
    // A declarative verb with no providerSpec is malformed — fail explicitly
    // rather than falling through to the IS isolate (which has no code to run).
    if (!skill.providerSpec) {
      return {
        kind: "not_found",
        message: `Declarative verb "${skill.name}" is missing its providerSpec.`,
      };
    }
    const result = await executeProviderVerb(skill.providerSpec, parameters, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId ?? undefined,
      connectionSelector: ctx.connectionSelector ?? null,
    });
    // executeProviderVerb flattens a provider FAILURE back to its `{success:false,
    // error}` envelope (execute-provider-verb.ts). Surface it as `kind:"error"` so
    // callers have ONE failure channel — never a success:false riding inside a
    // `kind:"run"`. A PROPOSED (unapproved write) envelope carries `proposed:true`
    // and is NOT an error: let it flow through as a run so the caller surfaces the
    // review inline. `capErrorMessage` is the SHARED envelope-message extractor.
    const isProposed =
      !!result &&
      typeof result === "object" &&
      (result as Record<string, unknown>).proposed === true;
    if (!isProposed) {
      const errMessage = capErrorMessage({ kind: "run", result });
      if (errMessage !== undefined) {
        // P1: carry the structured scalars stamped at the dispatcher (they ride on
        // the flattened envelope executeProviderVerb returned) alongside the message.
        const env = (result ?? {}) as {
          errorClass?: FailureErrorClass;
          providerRef?: string;
        };
        return {
          kind: "error",
          message: errMessage,
          errorClass: env.errorClass,
          providerRef: env.providerRef,
        };
      }
    }
    return { kind: "run", skillId: skill.id, result };
  }

  // A run-time connection pick can't reach the IS sandbox (`executeSkillViaIS`
  // takes no selector). Rather than SILENTLY running against the capability's
  // default credential — the wrong account, with no signal — refuse explicitly.
  // Declarative/provider verbs (above) honor the selector; for a code-backed
  // verb the user should set the capability's default connection instead.
  if (
    ctx.connectionSelector?.connectionId ||
    ctx.connectionSelector?.contextObjectId
  ) {
    return {
      kind: "deny",
      reason: `Verb "${skill.name}" runs as a code skill and does not support run-time connection selection. Set the capability's default connection instead.`,
    };
  }

  // TIER 2 (code/instruction): execute the backing skill in an isolated-vm
  // sandbox. Default (flag unset) = the IS sandbox over Hub Protocol HTTP
  // (`executeSkillViaIS`). Behind `SANDBOX_LOCAL === "1"` = the in-process
  // backend sandbox (`runSkillInSandbox`) — same bridges, no IS hop. The flag
  // defaults OFF so production behaviour is unchanged until it is flipped.
  // Both return the identical `SkillExecutionResult` envelope
  // `{success, result?, error?}`. UNWRAP it here so a caller receives the skill's
  // DATA (not the envelope) on success and the ONE `kind:"error"` channel on
  // failure — a success:false must never ride through as a `kind:"run"` result.
  const envelope =
    process.env.SANDBOX_LOCAL === "1"
      ? await runSkillInSandbox({
          skillId: skill.id,
          userId: ctx.userId,
          parameters,
          workspaceId: ctx.workspaceId,
          agentUserId: ctx.agentUserId ?? null,
        })
      : await executeSkillViaIS({
          skillId: skill.id,
          userId: ctx.userId,
          parameters,
          workspaceId: ctx.workspaceId,
        });
  if (!envelope.success) {
    return {
      kind: "error",
      message: envelope.error ?? `Skill "${skill.name}" execution failed.`,
      // P1: a code-skill provider failure now carries its classification too, so
      // an in-skill callProvider 401 surfaces the recovery chip — not just the
      // declarative-verb path above. Set by the IS (HubApiError.body) or the
      // in-process sandbox (dispatch result); undefined for a non-provider failure.
      errorClass: envelope.errorClass,
      providerRef: envelope.providerRef,
    };
  }
  return { kind: "run", skillId: skill.id, result: envelope.result };
}
