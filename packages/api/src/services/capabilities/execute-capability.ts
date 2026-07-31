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
 * for a queued run) so a caller can tell a fresh run from a governed queue. The
 * PROPOSAL path's external side effect is already at-most-once via
 * `dispatchExternalOnce` at approval. RESIDUAL GAP (documented, not yet closed): a
 * DIRECT owner/granted run of a WRITE verb that performs an external send has no
 * persisted run receipt, so a client-perceived-failure retry could double-send.
 * Closing it needs a small `capability_run_receipts` claim keyed by the idempotency
 * key (a schema addition, out of this file's lane) so the direct path can CAS a
 * one-time claim like the proposal path does. READ-only verbs are unaffected.
 */

import { db, skills, eq, and, desc, knowledgeRepository } from "@synap/database";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

import { emitAiDecision } from "../../utils/ai-feedback-events.js";
import { gateCapabilityExecution } from "./gate-capability-execution.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";
import type { ConnectionSelector } from "../../connectors/external-dispatch.js";
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
  | { kind: "error"; message: string }
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
   * Optional caller idempotency key (C1). Stamped onto a `capability.run` proposal
   * so an approved run and any retry correlate to one logical invocation. NOTE: the
   * DIRECT-run path (an owner/granted WRITE verb that performs an external send) has
   * no persisted receipt to replay, so this key cannot yet make that path
   * at-most-once — see the module note. Agent WRITE verbs without a grant route to
   * the PROPOSAL path, whose external dispatch IS at-most-once via
   * `dispatchExternalOnce` at approval.
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
  | { kind: "error"; message: string }
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
        return { kind: "error", message: errMessage };
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

  // TIER 2 (code/instruction): execute the backing skill in the IS sandbox.
  // executeSkillViaIS ALWAYS returns the `SkillExecutionResult` envelope
  // `{success, result?, error?}`. UNWRAP it here so a caller receives the skill's
  // DATA (not the envelope) on success and the ONE `kind:"error"` channel on
  // failure — a success:false must never ride through as a `kind:"run"` result.
  const envelope = await executeSkillViaIS({
    skillId: skill.id,
    userId: ctx.userId,
    parameters,
    workspaceId: ctx.workspaceId,
  });
  if (!envelope.success) {
    return {
      kind: "error",
      message: envelope.error ?? `Skill "${skill.name}" execution failed.`,
    };
  }
  return { kind: "run", skillId: skill.id, result: envelope.result };
}
