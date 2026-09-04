/**
 * The ONE governed persistence path for a RULE.
 *
 * A rule is materialized as a `skills` row (`kind: "instruction"`,
 * `category: "rule"`) whose `metadata.rule` blob carries intent / scope
 * (including the cross-cutting `projectId`) / `expiresAt` / lineage /
 * divergence snapshot — see `./index.ts` for the full persistence decision and
 * why it is a composition, not a new table.
 *
 * Governed under its OWN door (`rule/create`, declared in
 * `@synap/governance-policy`) rather than piggy-backing on `skill/create`,
 * because approving a rule must ALSO write the lineage edges to its fact and
 * behaviour halves — work `skill/create`'s approval half knows nothing about.
 * The approval half lives in
 * `routers/proposals/executors/rule.ts` and re-enters THIS function.
 */

import { randomUUID } from "node:crypto";
import { db, skills } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  classifyRuleIntent,
  type RuleShape,
} from "../knowledge/classify-intent.js";
import {
  RULE_CATEGORY,
  RULE_METADATA_KEY,
  buildRuleMetadata,
  hashFlowDefinition,
  linkRuleHalves,
  ruleNameFromIntent,
  type RuleBehaviourRecord,
  type RuleRouting,
  type RuleScope,
} from "./index.js";
import { normalizeExpiresAt } from "./expiry.js";
import { compileRuleSentence, type RuleCompileFailure } from "./compile.js";
import { readRuleSentence } from "./sentence-schema.js";
import { automations, eq, inArray } from "@synap/database";

const logger = createLogger({ module: "rules-create" });

export interface CreateRuleGovernedInput {
  userId: string;
  /** Present ⇒ an AGENT authored this; the gate routes it to a proposal. */
  agentUserId?: string;
  /**
   * The agent that authored this rule's BEHAVIOUR, when it is not the caller.
   *
   * These are two different questions and they were collapsed onto one field.
   * The approval replay deliberately re-enters this door with NO `agentUserId`
   * so the re-entrant gate auto-grants for the operator — correct for the rule
   * row's ownership. But the compiled automation's draft floor keys on WHO WROTE
   * IT, and reading the same field made `rule/create` a strictly wider path than
   * `automation/create`: an agent that cannot get a live trigger through the
   * automation door got one through the rule door plus one human approval.
   * The sibling executor (`executors/automation.ts`) has always threaded the
   * author through; this is that thread.
   */
  behaviourAuthorAgentUserId?: string;
  workspaceId?: string | null;
  intent: string;
  scope: RuleScope;
  /**
   * When this rule stops applying. Accepted as any parseable instant and
   * normalised to canonical ISO-8601 UTC; a non-instant is REFUSED here rather
   * than stored (a rule that cannot expire is not the same rule).
   */
  expiresAt?: string | Date;
  /** Skill id of a SEPARATE fact half, when the rule did not author its own. */
  factSkillId?: string;
  /**
   * The rule's structured WHEN/WHERE/THEN sentence, as it arrived off the wire
   * (tRPC input, stored proposal payload, Hub REST body) — `unknown` by design;
   * it is parsed here through `readRuleSentence`, never trusted.
   *
   * Present ⇒ this rule has BEHAVIOUR, and it is compiled into an automation
   * by this door or the create is REFUSED. Absent ⇒ prose-only (a `fact` rule),
   * which is legitimate and unchanged.
   */
  sentence?: unknown;
  /** Automations this rule produced. */
  automationIds?: string[];
  /** Folded into the gate payload for observability. */
  auditSource?: string;
}

/**
 * NON-FATAL signal: the rule's text describes something that RUNS, but no
 * behaviour is attached to it, so nothing will.
 *
 * This is INFORMATION, not a refusal — the rule is created either way. It now
 * covers exactly ONE case: a rule whose text describes a behaviour but which
 * carries NO sentence to compile and NO linked automation, so it is stored as
 * prose that will never execute. A rule WITH a sentence never carries this — it
 * either compiles into an automation or the create is refused outright.
 * (Before the compiler existed this door only LINKED pre-existing automations
 * and every live caller passed `automationIds: []`, so this was the common
 * case rather than the residue.)
 *
 * A `fact` rule ("Acme prefers async") is legitimately prose-only, so it never
 * carries this. Neither does a one-shot ask, which is not a standing rule at
 * all.
 */
export interface RuleBehaviourGap {
  /** The behavioural shape the text implies. */
  shape: RuleShape;
  /** Short, human. Safe to show a user verbatim. */
  reason: string;
}

export type CreateRuleGovernedResult =
  | {
      status: "created";
      ruleId: string;
      /**
       * Every automation this rule is now linked to — the ones passed in PLUS
       * the one compiled from the sentence here. Returned because the approval
       * executor writes a `materialized` receipt for revert/audit, and reading
       * the request payload instead omitted the only automation the approval
       * actually created.
       */
      automationIds: string[];
      needsBehaviour?: RuleBehaviourGap;
    }
  | {
      status: "proposed";
      proposalId: string;
      needsBehaviour?: RuleBehaviourGap;
    }
  | {
      status: "denied";
      reason: string;
      /**
       * Present when the refusal came from COMPILING the sentence — names the
       * clause (WHEN / WHERE / THEN) so the editor can point at the row that
       * failed instead of showing a bare error.
       */
      failure?: RuleCompileFailure;
    };

/**
 * A shape is BEHAVIOURAL when materialising it would mean something running:
 * everything except a statement of fact and the honest `unknown` fallback.
 */
function isBehaviouralShape(shape: RuleShape): boolean {
  return shape !== "fact" && shape !== "unknown";
}

/**
 * Snapshot each behaviour automation's flowDefinition AT CREATION so a reader
 * can later detect that a directly-edited automation no longer matches its
 * rule. Detection only — nothing reconciles.
 */
async function snapshotBehaviours(
  automationIds: string[]
): Promise<RuleBehaviourRecord[]> {
  if (automationIds.length === 0) return [];
  const rows = await db
    .select({ id: automations.id, flowDefinition: automations.flowDefinition })
    .from(automations)
    .where(inArray(automations.id, automationIds));
  const byId = new Map(rows.map((r) => [r.id, r.flowDefinition]));
  return automationIds.map((automationId) => ({
    automationId,
    // A missing row hashes its own absence — the divergence reader reports it
    // as "missing" from the automations query, not as a silent match.
    flowHash: hashFlowDefinition(byId.get(automationId) ?? null),
  }));
}

export async function createRuleGoverned(
  input: CreateRuleGovernedInput
): Promise<CreateRuleGovernedResult> {
  const intent = input.intent.trim();
  if (!intent) {
    return { status: "denied", reason: "A rule needs an intent." };
  }
  // Normalised BEFORE the gate so the proposal payload and a direct create
  // store the same canonical string, and so a bad instant is refused up front
  // rather than after a proposal has been filed.
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const workspaceId =
    input.scope.kind === "workspace"
      ? (input.scope.workspaceId ?? input.workspaceId ?? null)
      : (input.workspaceId ?? null);
  // COPIED, not aliased: the compiled automation's id is pushed onto this below,
  // and `skills.createRule` passes its zod-parsed array straight in — mutating a
  // caller's input is a side effect nobody reading the call site can see.
  const automationIds = [...(input.automationIds ?? [])];
  /** Only the ids this call CREATED — the compensation below must not archive
   *  a pre-existing automation the caller merely linked. */
  const automationsCreatedHere: string[] = [];
  const ruleId = randomUUID();

  // ── BEHAVIOUR: compile the sentence, or REFUSE ──────────────────────────
  // Before the gate, because compiling is PURE and a rule that cannot run must
  // not cost the owner a proposal to review. A refusal names the clause.
  let compiled: ReturnType<typeof compileRuleSentence> | null = null;
  if (input.sentence !== undefined && input.sentence !== null) {
    const sentence = readRuleSentence(input.sentence);
    if (!sentence) {
      return {
        status: "denied",
        reason:
          "This rule's WHEN/THEN could not be read. It was not saved, because a rule stored with an unreadable sentence would silently never run.",
        failure: {
          clause: "WHEN",
          reason: "The rule sentence did not match the expected shape.",
        },
      };
    }
    compiled = compileRuleSentence(sentence);
    if (!compiled.ok) {
      // The whole point of this wave: an intent that describes something
      // running is never persisted as prose that cannot run. Nine automation
      // products were surveyed and not one stores an enabled-but-inert rule.
      return {
        status: "denied",
        reason: compiled.failure.reason,
        failure: compiled.failure,
      };
    }
  }

  // Classify BEFORE the gate so the routing rides in the proposal payload —
  // an approved rule must be byte-identical to a directly created one.
  // Context is empty by contract: the classifier is then a PURE function of
  // `intent`, which is what makes the approval replay reproduce this exact
  // routing without the payload having to be trusted.
  const route = classifyRuleIntent(intent, {});
  const routing: RuleRouting = {
    shape: route.primary,
    confidence: route.shapes[0]?.confidence ?? 0,
    oneShot: route.oneShot,
    cues: route.shapes[0]?.cues ?? [],
  };

  // Non-fatal: reported, never enforced. Nothing below branches on it.
  const needsBehaviour: RuleBehaviourGap | undefined =
    isBehaviouralShape(routing.shape) &&
    !routing.oneShot &&
    automationIds.length === 0 &&
    // A compiled sentence IS the behaviour — it becomes an automation below.
    compiled === null
      ? {
          shape: routing.shape,
          reason: `This rule describes something that should run (${routing.shape}), but no automation is attached to it — it is stored as prose and will not execute until a behaviour is linked.`,
        }
      : undefined;

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId,
    workspaceId: workspaceId ?? undefined,
    subjectType: "rule",
    action: "create",
    // FULL payload — an approved proposal must materialize the real rule
    // (intent + scope + expiry + both halves), never a labelled shell. That
    // "the gate stored only {id}" shape is the exact defect this repo has
    // shipped three times.
    data: {
      id: ruleId,
      intent,
      scope: input.scope,
      ...(expiresAt ? { expiresAt } : {}),
      ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
      automationIds,
      routing,
      // Replay sufficiency: an approved rule must be byte-identical to a direct
      // create, and the automation is built from the SENTENCE, not from the
      // prose. Storing only `intent` would approve a rule whose behaviour the
      // reviewer saw and the replay could not reproduce.
      ...(compiled ? { sentence: input.sentence } : {}),
      ...(input.auditSource ? { auditSource: input.auditSource } : {}),
    },
  });

  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...(needsBehaviour ? { needsBehaviour } : {}),
    };
  }

  // ── Materialize the compiled behaviour ─────────────────────────────────
  // AFTER the gate: a proposed rule must not leave an automation behind if the
  // owner never approves it. Through the ONE insert door
  // (`materializeAutomationForPrincipal`), which derives the draft floor from
  // the principal itself — an AGENT-authored rule's automation lands `draft`,
  // on the direct path AND on the approval replay (see
  // `behaviourAuthorAgentUserId`). A rule a HUMAN authored but could not create
  // for lack of permission keeps its requested status on approval, exactly like
  // that human's own direct create: P2-3 is about an agent planting a live
  // trigger, not about the approval step itself.
  // Dynamic import mirrors `apply-approval.ts`: the router module pulls in the
  // whole tRPC surface, and a service must not depend on that at load time.
  if (compiled) {
    // The DIRECT path never reaches here with an `agentUserId` — the gate
    // returns `proposed` above — so on this path the author only ever arrives
    // via `behaviourAuthorAgentUserId`, from the approval replay. Both are read
    // so the field cannot become the only source and rot.
    const behaviourAuthor =
      input.agentUserId ?? input.behaviourAuthorAgentUserId;
    const { materializeAutomationForPrincipal } =
      await import("../../routers/automations.js");
    try {
      const automationId = await materializeAutomationForPrincipal({
        database: db,
        definition: {
          // THE RULE'S SCOPE, not the calling workspace. `workspaceId` above
          // resolves the POD branch to `input.workspaceId ?? null` — the
          // workspace the caller happened to be in — so a rule scoped
          // `{kind:"pod"}` compiled to an automation pinned to ONE workspace
          // while its `skills` row (line ~399, the same expression used here)
          // was correctly pod-wide. Every surface read the rule as pod-wide and
          // it fired for a fraction of what it said, with nothing to surface the
          // gap: `snapshotBehaviours` hashes only `flowDefinition`, so the
          // divergence reader is blind to scope.
          //
          // A pod-wide automation IS a supported lane — `podWideMatch`
          // (automation-trigger-matcher.ts) pairs `workspaceId IS NULL` with
          // `createdBy = userId`, so it matches the owner's events across every
          // workspace, which is exactly what "pod" means here. The one gap is a
          // pod-wide automation meeting a pod-wide EVENT, which the matcher
          // skips with a loud warning — a pre-existing executor-side limitation,
          // not something this door introduces.
          workspaceId: input.scope.kind === "workspace" ? workspaceId : null,
          name: ruleNameFromIntent(intent),
          description: intent,
          triggerType: compiled.trigger.triggerType,
          triggerConfig: compiled.trigger.triggerConfig,
          flowDefinition: compiled.flow,
          status: "active",
          // `source: "user"` for BOTH principals, deliberately. The door's
          // `"ai" | "agent"` branch demands an authored Gets/Stores/Reacts data
          // contract, which a sentence-compiled flow has no way to produce — so
          // declaring an agent-authored rule "agent" here would refuse every
          // single one. The agent floor is NOT source-based anyway: the draft
          // forcing below is derived from `agentUserId` inside the insert door.
          source: "user",
          // ── R3: the metadata the RULES LIST already reads ────────────────
          // `kind: "rule"` is not decoration — it is the ONE discriminator the
          // consumer filters on (`RulesList.tsx` drops every row whose
          // `metadata.kind !== "rule"`). Stamping only `ruleId` meant every
          // rule created through this governed door (MCP, CLI, Hub REST, the
          // browser's CommandPanel rule door, and the approval replay) was
          // invisible in the Rules list, while the older browser modal — which
          // writes the automation directly WITH `kind` — kept the list looking
          // like it worked. Same key, same value, both doors.
          //
          // `projectId` is the cross-cutting lens the same filter reads, and it
          // is the only other scope key this door actually holds. The list also
          // filters on `capabilityId` / `channelId` / `entityId`; `RuleScope`
          // here carries none of them, so a rule created through this door is
          // correctly absent from those SCOPED mounts rather than mislabelled.
          metadata: {
            ruleId,
            kind: RULE_CATEGORY,
            ...(input.scope.projectId
              ? { projectId: input.scope.projectId }
              : {}),
          },
        } as Parameters<
          typeof materializeAutomationForPrincipal
        >[0]["definition"],
        createdBy: input.userId,
        ...(behaviourAuthor ? { agentUserId: behaviourAuthor } : {}),
      });
      if (automationId) {
        automationIds.push(automationId);
        automationsCreatedHere.push(automationId);
      }
    } catch (err) {
      // The insert door validates against the live catalog (does this command
      // exist? is this skill resolvable?) — checks the pure compiler cannot
      // make. A failure there means the rule cannot run, so it is a REFUSAL,
      // not a rule kept as prose.
      logger.warn({ err, ruleId }, "rule behaviour failed to materialize");
      return {
        status: "denied",
        reason: `This rule's THEN cannot run: ${(err as Error).message}`,
        failure: { clause: "THEN", reason: (err as Error).message },
      };
    }
  }

  const behaviours = await snapshotBehaviours(automationIds);
  const metadata = buildRuleMetadata({
    intent,
    scope: input.scope,
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
    behaviours,
    routing,
    // Persist the authored WHEN/THEN so the rule stays REPLAYABLE. It was
    // written into the proposal payload and nowhere else, so a rule could be
    // dry-run while proposed and never once approved — preview available for
    // the rule you had not trusted yet, and not for the one that had been
    // running for a month.
    ...(input.sentence !== undefined ? { sentence: input.sentence } : {}),
  });

  // COMPENSATION for the ordering below. The automation is created BEFORE the
  // rule row, because the rule's metadata carries a divergence snapshot of its
  // behaviour and cannot be built until the automation exists. If the rule
  // insert then fails, an ACTIVE automation is left behind whose
  // `metadata.ruleId` names a row that does not exist — a live trigger with no
  // rule, which nothing would ever surface or clean up. Archiving is the repo's
  // soft-delete convention and is what `status` gates firing on.
  const archiveOrphanedBehaviour = async (cause: unknown) => {
    if (automationsCreatedHere.length === 0) return;
    try {
      await db
        .update(automations)
        .set({ status: "archived", updatedAt: new Date() })
        .where(inArray(automations.id, automationsCreatedHere));
      logger.warn(
        { err: cause, ruleId, automationIds: automationsCreatedHere },
        "rule insert failed — archived the automation it had already created"
      );
    } catch (archiveErr) {
      // Nothing left to do but say so loudly: a live trigger with no rule.
      logger.error(
        { err: archiveErr, ruleId, automationIds: automationsCreatedHere },
        "rule insert failed AND its automation could not be archived — an active automation is orphaned"
      );
    }
  };

  let row: { id: string } | undefined;
  try {
    [row] = await db
      .insert(skills)
      .values({
        id: ruleId,
        userId: input.userId,
        workspaceId: input.scope.kind === "workspace" ? workspaceId : null,
        kind: "instruction",
        scope: input.scope.kind,
        category: RULE_CATEGORY,
        name: ruleNameFromIntent(intent),
        description: intent,
        // The rule's intent IS the fact the agent reads while reasoning — that is
        // why a rule lives in `skills` and not in a table of its own.
        body: intent,
        status: "active",
        // A rule is inert prose until an owner approves it, exactly like any
        // other agent-authored instruction skill (prompt-injection surface).
        approved: !input.agentUserId,
        tags: ["rule"],
        metadata: { [RULE_METADATA_KEY]: metadata },
      })
      .returning({ id: skills.id });
  } catch (err) {
    await archiveOrphanedBehaviour(err);
    throw err;
  }

  const materializedId = row?.id ?? ruleId;

  // ── Lineage edges — NOT best-effort ──────────────────────────────────────
  // The `skill --activates--> automation` edge IS the rule's membership store
  // (`services/rules/lineage.ts` is the reader; divergence detection and
  // `skills.dryRunRule` resolve a rule's automations from it). Swallowing a
  // failure here therefore keeps a rule row that has silently lost its
  // behaviour — data loss dressed as a warning, which is what the old
  // `"rule created but lineage edges failed (rule kept)"` catch did.
  //
  // Compensate the same way the insert path does — archive the automation this
  // call created — and additionally delete the rule row this call inserted, so
  // the whole create unwinds rather than leaving a half-rule behind. Then
  // rethrow: the caller must not be told a rule was created.
  try {
    await linkRuleHalves({
      ruleSkillId: materializedId,
      ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
      automationIds,
      workspaceId,
    });
  } catch (err) {
    await archiveOrphanedBehaviour(err);
    try {
      await db.delete(skills).where(eq(skills.id, materializedId));
    } catch (deleteErr) {
      logger.error(
        { err: deleteErr, ruleId: materializedId },
        "rule lineage edges failed AND the rule row could not be removed — a rule exists with no membership edge"
      );
    }
    throw err;
  }

  return {
    status: "created",
    ruleId: materializedId,
    automationIds,
    ...(needsBehaviour ? { needsBehaviour } : {}),
  };
}
