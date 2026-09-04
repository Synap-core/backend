/**
 * `command` / `skill` / `capability` step executors — the three node types that
 * dispatch work OUT of the flow (IS task, or the canonical capability router).
 */
import {
  db,
  eq,
  automationStepRuns,
  normalizeCommandNodeData,
} from "@synap/database";
import type { CommandNodeDef, LegacyCommandNodeData } from "@synap/database";
import {
  resolveTemplate,
  deepResolveTemplates,
  resolveInputMapping,
} from "../template-resolve.js";
import { dispatchViaCapabilityRouter } from "../capability-dispatch.js";
import {
  guardProducerEffect,
  PolicyBlockedError,
} from "../../utils/automation-governance.js";
import {
  resolveVaultReferences,
  isVaultReference,
} from "../../utils/vault-resolver.js";
import {
  getDefaultActiveService,
  requestTaskExecute,
} from "@synap/intelligence-client";
import { logger } from "../automation-executor-logger.js";
import type { StepContext } from "../automation-executor-types.js";

/**
 * Execute a command step by calling the Intelligence Service.
 */
export async function executeCommandStep(
  rawData: CommandNodeDef["data"] & LegacyCommandNodeData,
  context: StepContext,
  workspaceId: string,
  ownerId: string,
  // CONFUSED-DEPUTY GUARD: the causal-chain producer. A `command` node spawns an
  // IS agent AS the owner (`userId: ownerId`), so an agent-produced trigger firing
  // a HUMAN-owned automation would launder an agentic IS task through owner-bypass.
  // Fail closed when an agent is in the chain and the producer's ladder would not
  // auto-execute. Absent → owner-only behavior, unchanged.
  producerAgentUserId?: string | null
): Promise<Record<string, unknown>> {
  const guard = await guardProducerEffect({
    producerAgentUserId,
    principalUserId: ownerId,
    workspaceId,
    subjectType: "capability",
    action: "execute",
  });
  if ("block" in guard) {
    throw new PolicyBlockedError(
      guard.kind,
      guard.kind === "deny"
        ? `command denied by producer-agent governance (confused-deputy guard): ${guard.reason ?? "capability denied"}`
        : `command cannot auto-execute: an agent produced this trigger, so a human-owned automation may not run it ungoverned (confused-deputy guard).`
    );
  }

  const data = normalizeCommandNodeData(rawData);

  let resolvedInputs = resolveInputMapping(data.inputMapping, context);

  // Resolve vault references in input values (e.g., API keys)
  const stringInputs: Record<string, string> = {};
  let hasVaultRefs = false;
  for (const [k, v] of Object.entries(resolvedInputs)) {
    const sv = String(v);
    stringInputs[k] = sv;
    if (isVaultReference(sv)) hasVaultRefs = true;
  }
  if (hasVaultRefs) {
    const resolved = await resolveVaultReferences(stringInputs, ownerId);
    resolvedInputs = resolved;
  }

  // Build the prompt from command title + resolved inputs
  let prompt = data.commandTitle ?? "Execute automation command";
  if (data.promptOverride) {
    prompt = resolveTemplate(data.promptOverride, context);
  }

  // Add resolved inputs as context
  const inputSummary = Object.entries(resolvedInputs)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  if (inputSummary) {
    prompt += `\n\nInputs:\n${inputSummary}`;
  }

  // Canonical IS credential resolution (decrypted DB key), not stale env.
  const { endpoint: isUrl, apiKey: isApiKey } = await getDefaultActiveService();

  // ── Generic command execution ──────────────────────────────────────────
  // IS transport (fetch + X-API-Key + 60s abort) is the SSOT
  // `requestTaskExecute` in @synap/intelligence-client — no raw fetch here.
  try {
    const result = await requestTaskExecute(isUrl, isApiKey, {
      taskId: data.commandId ?? "automation-command",
      action: prompt,
      context: resolvedInputs,
      // Attribute the IS work to the automation's owning principal
      // (automation.createdBy — the agent user id for AI-created automations)
      // instead of the unattributed "system". Writes the IS performs back to
      // the pod will then carry this identity through the governance gate.
      userId: ownerId,
      workspaceId,
    });
    return { ...result, resolvedInputs };
  } catch (err) {
    logger.error(
      { err, commandId: data.commandId },
      "Command step IS call failed"
    );
    throw err;
  }
}

/**
 * Execute a `skill` node — resolve its inputMapping and dispatch through the
 * CANONICAL router (all 3 tiers + gate). Extracted from the main switch so the
 * SAME path runs both in the top-level pass AND per-item inside a loop body
 * (where `context.loop` is set, so `{{loop.item}}` resolves per iteration).
 *
 * `stepRun` is only present in the main pass — when given, the resolved inputs
 * are persisted to the step-run record for observability. Loop children have no
 * per-child step-run row, so it is omitted there.
 */
export async function executeSkillNode(
  data: {
    skillId?: string;
    inputMapping?: Record<string, string>;
  },
  context: StepContext,
  opts: {
    workspaceId: string;
    ownerId: string;
    stepRun?: { id: string };
    // CONFUSED-DEPUTY GUARD (see executeCommandStep) — the causal-chain producer.
    producerAgentUserId?: string | null;
  }
): Promise<unknown> {
  const skillId = data.skillId;
  if (!skillId) throw new Error("Skill node has no skillId");

  const skillGuard = await guardProducerEffect({
    producerAgentUserId: opts.producerAgentUserId,
    principalUserId: opts.ownerId,
    workspaceId: opts.workspaceId,
    subjectType: "capability",
    action: "execute",
  });
  if ("block" in skillGuard) {
    throw new PolicyBlockedError(
      skillGuard.kind,
      skillGuard.kind === "deny"
        ? `Skill ${skillId} denied by producer-agent governance (confused-deputy guard): ${skillGuard.reason ?? "capability denied"}`
        : `Skill ${skillId} cannot auto-execute: an agent produced this trigger, so a human-owned automation may not run it ungoverned (confused-deputy guard).`
    );
  }

  const inputMapping = data.inputMapping ?? {};
  // deepResolveTemplates (NOT resolveInputMapping) so an exact `{{step.x}}`
  // placeholder that resolves to an array/object reaches the skill as its NATIVE
  // shape. resolveInputMapping → resolveTemplate JSON-stringifies non-scalars,
  // which made a skill's zod `z.array(...)` param fail with "expected array,
  // received string". Output nodes already resolve this way; skill/capability
  // dispatch must match. (Embedded `"text {{x}}"` still renders to a string.)
  const resolvedInputs = deepResolveTemplates(inputMapping, context) as Record<
    string,
    unknown
  >;

  if (opts.stepRun) {
    await db
      .update(automationStepRuns)
      .set({ resolvedInputs })
      .where(eq(automationStepRuns.id, opts.stepRun.id));
  }

  // ── Canonical dispatch (all 3 tiers + gate) ────────────────────────
  // Route through `executeCapability` (via the in-process IoC slot) — it
  // resolves the skill, GATES internally, and runs builtin/declarative/
  // code tiers. An automation runs as the workspace OWNER (userId =
  // ownerId, no agent identity), so the gate resolves:
  //   • owner runs their OWN skill  → owner-bypass → run
  //   • non-owner-owned + approved  → auto         → run
  //   • non-owner-owned + UNapproved→ propose (FAILS CLOSED below)
  // A mid-flow automation has no interactive review surface, so a
  // propose/deny/not_found verdict FAILS CLOSED (throws); dry-run is
  // honored as a no-op preview.
  const skillDispatch = await dispatchViaCapabilityRouter({
    skillId,
    parameters: resolvedInputs,
    workspaceId: opts.workspaceId,
    userId: opts.ownerId,
  });
  if (skillDispatch.kind === "deny") {
    throw new Error(
      `Skill ${skillId} refused by capability gate: ${skillDispatch.reason}`
    );
  }
  if (skillDispatch.kind === "proposed") {
    throw new Error(
      `Skill ${skillId} requires human approval and cannot run inside an automation; automation skill node refused.`
    );
  }
  if (skillDispatch.kind === "not_found") {
    throw new Error(
      `Skill ${skillId} could not be dispatched: ${skillDispatch.message}`
    );
  }
  if (skillDispatch.kind === "error") {
    // The skill ran in the IS sandbox and FAILED (success:false) — the node fails
    // rather than storing the error envelope as node output.
    throw new Error(`Skill ${skillId} failed: ${skillDispatch.message}`);
  }
  if (skillDispatch.kind === "dry-run") {
    // Grant resolved to dry-run preview — no external side effect.
    return { dryRun: true, skillId: skillDispatch.skillId };
  }
  // kind === "run": return the skill's execution result DIRECTLY as the node
  // output (the IS SkillExecutionResult for a code skill, the handler/provider
  // return for builtin/declarative). Stored flat → `steps.<id>.output.<field>`.
  return skillDispatch.result;
}

/**
 * Execute a `capability` node — the typed/governed Tool → Verb sibling of the
 * `skill` node. A verb is BACKED BY A SKILL; dispatch routes verb → the
 * canonical `executeCapability` router (same door as `executeSkillNode`).
 * Extracted so the SAME path runs both in the main pass AND per-item in a loop.
 *
 * `stepRun` is only present in the main pass (see `executeSkillNode`).
 */
export async function executeCapabilityNode(
  data: {
    capabilityId?: string;
    verbId?: string;
    inputMapping?: Record<string, string>;
    connectionSelector?: {
      connectionId?: string;
      contextObjectId?: string;
    };
    connectionId?: string;
  },
  context: StepContext,
  opts: {
    workspaceId: string;
    ownerId: string;
    stepRun?: { id: string };
    // CONFUSED-DEPUTY GUARD (see executeCommandStep) — the causal-chain producer.
    producerAgentUserId?: string | null;
  }
): Promise<unknown> {
  const verbId = data.verbId;
  if (!verbId) throw new Error("Capability node has no verbId");

  // The verb is `<subjectType>.<action>` shaped (e.g. `mail.send`) — split so the
  // producer ladder's deny-floors can key on the honest subjectType/action.
  const verbDot = verbId.indexOf(".");
  const capGuard = await guardProducerEffect({
    producerAgentUserId: opts.producerAgentUserId,
    principalUserId: opts.ownerId,
    workspaceId: opts.workspaceId,
    subjectType: verbDot > 0 ? verbId.slice(0, verbDot) : "capability",
    action: verbDot > 0 ? verbId.slice(verbDot + 1) : "execute",
  });
  if ("block" in capGuard) {
    throw new PolicyBlockedError(
      capGuard.kind,
      capGuard.kind === "deny"
        ? `Capability ${verbId} denied by producer-agent governance (confused-deputy guard): ${capGuard.reason ?? "capability denied"}`
        : `Capability ${verbId} cannot auto-execute: an agent produced this trigger, so a human-owned automation may not run it ungoverned (confused-deputy guard).`
    );
  }

  const capInputMapping = data.inputMapping ?? {};
  // deepResolveTemplates: preserve array/object params from an exact `{{...}}`
  // placeholder so a capability's zod schema (e.g. mail_triage `emails:
  // z.array(...)`) receives the native shape, not a JSON string. See the skill
  // node above — same bug class ("expected array, received string").
  const capResolvedInputs = deepResolveTemplates(
    capInputMapping,
    context
  ) as Record<string, unknown>;

  if (opts.stepRun) {
    await db
      .update(automationStepRuns)
      .set({ resolvedInputs: capResolvedInputs })
      .where(eq(automationStepRuns.id, opts.stepRun.id));
  }

  // Runtime 1-of-N connection selection (Wave 4): explicit selector, or
  // a bare connectionId shorthand. Absent → default/authBinding behavior.
  const connectionSelector =
    data.connectionSelector ??
    (data.connectionId ? { connectionId: data.connectionId } : null);

  // ── Canonical dispatch (SAME door as `case "skill"`) ──────────────
  // Runs as the workspace OWNER (userId = ownerId, no agent identity):
  //   • owner runs their OWN skill  → owner-bypass → run
  //   • non-owner-owned + approved  → auto         → run
  //   • non-owner-owned + UNapproved→ propose (FAILS CLOSED below)
  // A mid-flow automation has no interactive review surface, so a
  // propose/deny/not_found verdict throws; dry-run is honored as a no-op.
  const capDispatch = await dispatchViaCapabilityRouter({
    verbId,
    parameters: capResolvedInputs,
    workspaceId: opts.workspaceId,
    userId: opts.ownerId,
    connectionSelector,
  });
  if (capDispatch.kind === "deny") {
    throw new Error(
      `Capability ${verbId} refused by capability gate: ${capDispatch.reason}`
    );
  }
  if (capDispatch.kind === "proposed") {
    throw new Error(
      `Capability ${verbId} requires human approval and cannot run inside an automation; capability node refused.`
    );
  }
  if (capDispatch.kind === "not_found") {
    throw new Error(
      `Capability ${verbId} could not be dispatched: ${capDispatch.message}`
    );
  }
  if (capDispatch.kind === "error") {
    // The verb ran and its handler FAILED — the node fails (never store the
    // failure envelope as node output).
    throw new Error(`Capability ${verbId} failed: ${capDispatch.message}`);
  }
  if (capDispatch.kind === "dry-run") {
    // Grant resolved to dry-run preview — no external side effect.
    return { dryRun: true, verbId, skillId: capDispatch.skillId };
  }
  // kind === "run": return the verb result DIRECTLY as the node output. Stored
  // flat → `steps.<id>.output.<field>` (ONE rule, same as every other node).
  return capDispatch.result;
}
