/**
 * The ONE governed UPDATE door for a RULE — and the door that ACTIVATES a draft.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * There was no update path for a rule at all. The skills router exposed
 * `createRule · dryRunRule · listRules · renewRule · getRule` and nothing that
 * could change a rule's sentence, and `skills.update` is not a substitute:
 * `intent` and `expiresAt` do not reach it, and `scope` is an OBJECT on
 * `createRule` and a BARE ENUM on `skills.update` — the fork class this
 * codebase repeatedly pays for. So editing a rule meant delete-and-recreate: a
 * new id, lost run history, lost lineage.
 *
 * The one back door — editing the compiled automation directly — is what the
 * system already reports as DAMAGE: `detectRuleDivergence` (./index.ts)
 * compares the flow hash the rule recorded against the automation's hash today,
 * and the phone renders it as "Its automation has been edited since the rule was
 * written, so what runs may no longer match this sentence." A product that
 * detects an edit as damage and offers no way to make the edit properly is
 * telling the user their only available action is the wrong one.
 *
 * ── THE SAME SHAPE AS CREATE, DELIBERATELY ──────────────────────────────────
 * This door takes `createRule`'s input shape — `intent`, the `RuleScope`
 * OBJECT (kind + workspaceId + projectId), `expiresAt`, `factSkillId`,
 * `sentence`, `automationIds`, `draft` — and rebuilds the whole metadata blob
 * through `buildRuleMetadata`. It does not shallow-merge. That is the lesson
 * `renewRule` already documents in its own header: `skills.update` merges a
 * metadata patch onto the row bag, so a caller who omits `intent` erases the
 * prose an agent reads and a caller who omits `behaviours` erases the
 * divergence snapshot. A door that silently corrupts the thing it edits is
 * worse than no door, because it looks like it works.
 *
 * `renewRule` stays: it is the cheap, ungoverned, single-field review-date move.
 * This is the governed full-shape edit.
 *
 * ── HOW `diverged` IS CLEARED (earned, never stamped) ───────────────────────
 * By RECOMPILING the sentence, REWRITING the automation from it, and only then
 * re-hashing. The snapshot is therefore a claim about a convergence this call
 * actually performed. Setting `flowHash` to the automation's current hash
 * without recompiling would be the durable-lie shape `.claude/rules/backend-rules.md`
 * names: a marker asserting a convergence that never ran, which then
 * short-circuits the comparator forever.
 *
 * ── THE AUTOMATION IS UPDATED IN PLACE, NOT REPLACED ────────────────────────
 * Through the automations router's own `update` procedure (via `createCaller`,
 * the pattern `executors/capability.ts` already uses for `skills.setApproved`),
 * so the rule inherits that door's event-pattern check, its
 * `assertValidTriggerFilters` gate, its flow-node + catalog validation, its
 * `assertWorkspaceWrite` floor and its monotonic `version` bump — with no
 * second implementation to drift. Keeping the automation's ID is the point:
 * `automation_runs` reference it, so replacing the row is exactly the
 * "lost run history" this door exists to avoid.
 *
 * The ONE case that cannot be an in-place update is a scope change that moves
 * the automation to a different workspace — `automations.update` cannot move a
 * row between workspaces, and a rule that changes workspace genuinely is a
 * different behaviour in a different lens. That path archives and re-creates,
 * and says so.
 */

import { db, skills, automations, eq, and, inArray } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { Context } from "../../context.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { classifyRuleIntent } from "../knowledge/classify-intent.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import {
  RULE_CATEGORY,
  RULE_METADATA_KEY,
  buildRuleMetadata,
  linkRuleHalves,
  readRuleMetadata,
  ruleNameFromIntent,
  unlinkRuleBehaviours,
  type RuleRouting,
  type RuleScope,
} from "./index.js";
import { normalizeExpiresAt } from "./expiry.js";
import { compileRuleSentence, type RuleCompileFailure } from "./compile.js";
import { applyRuleProjectScope } from "./scope.js";
import { readRuleSentence } from "./sentence-schema.js";
import { readRuleAutomationIds } from "./lineage.js";
import { snapshotBehaviours } from "./create.js";

const logger = createLogger({ module: "rules-update" });

export interface UpdateRuleGovernedInput {
  userId: string;
  /** Present ⇒ an AGENT authored this edit; the gate routes it to a proposal. */
  agentUserId?: string;
  /**
   * The agent that authored the BEHAVIOUR, when it is not the caller — threaded
   * for the same reason `createRuleGoverned` threads it: the compiled
   * automation's draft floor keys on WHO WROTE IT, and the approval replay
   * re-enters this door with no `agentUserId` so the gate auto-grants for the
   * operator. Reading the same field for both questions would make the rule
   * door a strictly wider path than the automation door.
   */
  behaviourAuthorAgentUserId?: string;
  /** The rule (`skills`) row being edited. */
  ruleId: string;
  /** The caller's workspace lens — used for the VISIBILITY floor, not the write. */
  workspaceId?: string | null;
  intent: string;
  scope: RuleScope;
  /** `null` CLEARS the review date; absent LEAVES IT UNCHANGED. */
  expiresAt?: string | Date | null;
  factSkillId?: string;
  /**
   * The full WHEN/WHERE/THEN. THREE states, like `expiresAt`: a sentence
   * REPLACES the behaviour, `null` REMOVES it (the rule becomes prose-only and
   * its automation is retired), and ABSENT leaves the stored sentence alone —
   * which then gets recompiled, so an edit to the prose cannot silently drop
   * the behaviour.
   */
  sentence?: unknown;
  /** Automations to link BESIDES the one this rule compiles. */
  automationIds?: string[];
  /**
   * `true` keeps (or returns) the rule to DRAFT: nothing is compiled and the
   * rule's own automation is archived, so a rule with holes has no artifact
   * that could fire. `false` ACTIVATES: the stored sentence is recompiled and
   * refused by clause if it still has a hole — which is why activation can
   * never be a status flip.
   */
  draft?: boolean;
  auditSource?: string;
}

export type UpdateRuleGovernedResult =
  | {
      status: "updated";
      ruleId: string;
      /** Every automation the rule is linked to AFTER the edit. */
      automationIds: string[];
      /** True when this edit left the rule as a draft (nothing can fire). */
      draft: boolean;
      /** Present when the edited behaviour is LIMITED to its project (`./scope.ts`). */
      scopeNote?: string;
    }
  | { status: "proposed"; proposalId: string; scopeNote?: string }
  | { status: "not_found" }
  | {
      status: "denied";
      reason: string;
      /** Present when the refusal came from COMPILING — names WHEN/WHERE/THEN. */
      failure?: RuleCompileFailure;
    };

/**
 * Is this automation the rule's OWN behaviour (compiled by the rule door), as
 * opposed to a pre-existing automation the author merely linked?
 *
 * `metadata.ruleId` is stamped by `createRuleGoverned` and by this door. The
 * distinction is load-bearing: an edit may rewrite or archive the automation the
 * RULE produced, and must never touch one the author attached.
 */
function isRuleOwned(metadata: unknown, ruleId: string): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>).ruleId === ruleId;
}

export async function updateRuleGoverned(
  input: UpdateRuleGovernedInput
): Promise<UpdateRuleGovernedResult> {
  const intent = input.intent.trim();
  if (!intent) {
    return { status: "denied", reason: "A rule needs an intent." };
  }

  // ── Load, floored by the SAME visibility predicate every rule door uses ──
  // `includeExpired: true` because an expired rule is a prime edit target — the
  // same reasoning `renewRule` and `getRule` already document. Enforcing expiry
  // on this read would make the door unable to act on one of its main cases.
  const row = await db.query.skills.findFirst({
    where: and(
      eq(skills.id, input.ruleId),
      eq(skills.category, RULE_CATEGORY),
      visibleSkillsWhere(input.userId, input.workspaceId ?? undefined, {
        includeExpired: true,
      })
    ),
  });
  if (!row) return { status: "not_found" };

  const existing = readRuleMetadata(
    row.metadata as Record<string, unknown> | null
  );
  if (!existing) {
    return {
      status: "denied",
      reason:
        "This skill is categorised as a rule but carries no rule metadata, so there is nothing to edit.",
    };
  }

  // ABSENT leaves the stored date alone; `null` clears it. Two different acts,
  // spelled differently, exactly as `renewRule` distinguishes them.
  const expiresAt =
    input.expiresAt === undefined
      ? existing.expiresAt
      : normalizeExpiresAt(input.expiresAt);

  const draft = input.draft === true;
  const workspaceId =
    input.scope.kind === "workspace"
      ? (input.scope.workspaceId ?? input.workspaceId ?? null)
      : (input.workspaceId ?? null);

  // ── COMPILE (or, for a draft, deliberately do not) ──────────────────────
  // Before the gate: compiling is pure, and a rule that cannot run must not
  // cost the owner a proposal to review. Identical contract to the create door,
  // including the DRAFT INTERLOCK — see the `draft` note on `RuleMetadata`.
  /**
   * ABSENT means "the sentence is not part of this edit" — so the STORED one is
   * carried forward and recompiled. Explicit `null` means "remove the
   * behaviour".
   *
   * ⚠️ This distinction is load-bearing and its absence was a real defect in the
   * first cut of this door: `sentence` is optional on the wire, so a caller
   * editing only the prose (or only the review date) sent no sentence, the door
   * compiled nothing, and the archive branch below RETIRED THE RULE'S
   * AUTOMATION — silently destroying the behaviour of a rule whose author had
   * touched one word of its description. Same three-state shape as `expiresAt`
   * above, for the same reason: set / clear / not-mentioned are three different
   * acts and collapsing any two of them destroys data.
   */
  const sentenceInput =
    input.sentence === undefined ? existing.sentence : input.sentence;

  let compiled: ReturnType<typeof compileRuleSentence> | null = null;
  let scopeNote: string | undefined;
  if (sentenceInput !== undefined && sentenceInput !== null) {
    const sentence = readRuleSentence(sentenceInput);
    if (!sentence) {
      return {
        status: "denied",
        reason:
          "This rule's WHEN/THEN could not be read. Nothing was changed, because a rule stored with an unreadable sentence would silently never run.",
        failure: {
          clause: "WHEN",
          reason: "The rule sentence did not match the expected shape.",
        },
      };
    }
    if (!draft) {
      compiled = compileRuleSentence(sentence);
      if (!compiled.ok) {
        // ACTIVATION IS A RECOMPILE, NOT A FLIP. This is the refusal that makes
        // the draft state safe: a hole that was tolerated while the rule sat as
        // a draft is named here, by clause, at the moment someone tries to make
        // it real. There is no code path that arms a rule without passing here.
        return {
          status: "denied",
          reason: compiled.failure.reason,
          failure: compiled.failure,
        };
      }
      // ── SCOPE: same binding as the create door — see `./scope.ts`. An
      // activation (draft → live) passes here too, so a draft saved with a
      // project its WHEN cannot carry is refused at the moment it would arm.
      const scoped = applyRuleProjectScope(compiled, input.scope.projectId);
      if (!scoped.ok) {
        return {
          status: "denied",
          reason: scoped.failure.reason,
          failure: scoped.failure,
        };
      }
      ({ compiled, scopeNote } = scoped);
    }
  }

  // Re-classified from the NEW intent, for the same reason the create door
  // classifies: the classifier is a pure function of `intent` with an empty
  // context, so the stored routing must track the text it describes. Keeping
  // the old routing after an intent rewrite would leave a stored explanation of
  // a decision made about different words.
  const route = classifyRuleIntent(intent, {});
  const routing: RuleRouting = {
    shape: route.primary,
    confidence: route.shapes[0]?.confidence ?? 0,
    oneShot: route.oneShot,
    cues: route.shapes[0]?.cues ?? [],
  };

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId,
    workspaceId: workspaceId ?? undefined,
    subjectType: "rule",
    action: "update",
    // FULL payload — an approved edit must reproduce THIS edit, not a labelled
    // shell. `id` is the rule being changed, so the executor re-enters this same
    // door rather than creating a second rule.
    data: {
      id: input.ruleId,
      intent,
      scope: input.scope,
      ...(expiresAt ? { expiresAt } : {}),
      // Explicit `null` must survive into the payload: "clear the review date"
      // is a real edit, and dropping it would approve into "leave it alone".
      ...(input.expiresAt === null ? { clearExpiresAt: true } : {}),
      ...(draft ? { draft: true } : {}),
      ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
      automationIds: input.automationIds ?? [],
      routing,
      // The RESOLVED sentence, not the request's: an approval replay must
      // rebuild the behaviour this edit actually produces, including one
      // carried forward from the stored rule.
      ...(sentenceInput !== undefined && sentenceInput !== null
        ? { sentence: sentenceInput }
        : {}),
      // An explicit REMOVAL has to survive into the payload as its own signal,
      // or approving it would fall back to "carry the stored sentence forward"
      // and quietly keep the behaviour the author asked to delete.
      ...(input.sentence === null ? { clearSentence: true } : {}),
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
      ...(scopeNote ? { scopeNote } : {}),
    };
  }

  // ── Reconcile the BEHAVIOUR half ────────────────────────────────────────
  // Membership from the EDGE — the store — never from `metadata.behaviours[]`,
  // which holds only the divergence snapshot.
  const linkedIds = await readRuleAutomationIds(input.ruleId);
  const linkedRows = linkedIds.length
    ? await db
        .select({
          id: automations.id,
          workspaceId: automations.workspaceId,
          metadata: automations.metadata,
        })
        .from(automations)
        .where(inArray(automations.id, linkedIds))
    : [];
  const owned = linkedRows.filter((a) => isRuleOwned(a.metadata, input.ruleId));
  /** Automations the AUTHOR attached. Never rewritten, never archived here. */
  const attached = linkedIds.filter((id) => !owned.some((o) => o.id === id));

  const targetWorkspaceId =
    input.scope.kind === "workspace" ? workspaceId : null;
  const behaviourAuthor = input.agentUserId ?? input.behaviourAuthorAgentUserId;
  const ownedAfter: string[] = [];
  const toArchive: string[] = [];

  if (compiled) {
    const reusable = owned.find((a) => a.workspaceId === targetWorkspaceId);
    // Any owned automation we are NOT reusing is retired — including one left
    // in the wrong workspace by a scope change, which `automations.update`
    // cannot move.
    toArchive.push(
      ...owned.filter((a) => a.id !== reusable?.id).map((a) => a.id)
    );
    if (reusable) {
      // IN PLACE, through the automations router's own door — see the header.
      // The id survives, so `automation_runs` keep pointing at the same
      // behaviour and the rule's run history is preserved across the edit.
      const { automationsRouter } =
        await import("../../routers/automations.js");
      const caller = automationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: targetWorkspaceId,
      } as unknown as Context);
      try {
        await caller.update({
          id: reusable.id,
          name: ruleNameFromIntent(intent),
          description: intent,
          triggerType: compiled.trigger.triggerType,
          triggerConfig: compiled.trigger.triggerConfig,
          flowDefinition: compiled.flow,
          metadata: {
            ruleId: input.ruleId,
            kind: RULE_CATEGORY,
            ...(input.scope.projectId
              ? { projectId: input.scope.projectId }
              : {}),
          },
        });
      } catch (err) {
        // The door validates against the live catalog — checks the pure
        // compiler cannot make. A failure means the edited rule cannot run, so
        // it is a REFUSAL and NOTHING is written: the rule keeps the sentence
        // and the behaviour it had before this call.
        return {
          status: "denied",
          reason: `This rule's THEN cannot run: ${(err as Error).message}`,
          failure: { clause: "THEN", reason: (err as Error).message },
        };
      }
      ownedAfter.push(reusable.id);
    } else {
      const { materializeAutomationForPrincipal } =
        await import("../../routers/automations.js");
      try {
        const automationId = await materializeAutomationForPrincipal({
          database: db,
          definition: {
            workspaceId: targetWorkspaceId,
            name: ruleNameFromIntent(intent),
            description: intent,
            triggerType: compiled.trigger.triggerType,
            triggerConfig: compiled.trigger.triggerConfig,
            flowDefinition: compiled.flow,
            status: "active",
            source: "user",
            metadata: {
              ruleId: input.ruleId,
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
        if (automationId) ownedAfter.push(automationId);
      } catch (err) {
        return {
          status: "denied",
          reason: `This rule's THEN cannot run: ${(err as Error).message}`,
          failure: { clause: "THEN", reason: (err as Error).message },
        };
      }
    }
  } else {
    // NO compiled behaviour — the rule is now a draft, or prose-only. EVERY
    // automation this rule owns is archived, so the rule's inertness is the
    // absence of a firing artifact rather than a flag on one. This is what makes
    // "return a live rule to draft" safe: there is nothing left to flip active.
    toArchive.push(...owned.map((a) => a.id));
  }

  if (toArchive.length > 0) {
    await db
      .update(automations)
      .set({ status: "archived", updatedAt: new Date() })
      .where(inArray(automations.id, toArchive));
    // Drop the membership edge too. An archived automation still named by the
    // `activates` edge would read as a permanent `"missing"` divergence on a
    // rule that is actually fine.
    await unlinkRuleBehaviours({
      ruleSkillId: input.ruleId,
      automationIds: toArchive,
    });
    logger.info(
      { ruleId: input.ruleId, automationIds: toArchive, draft },
      "rule update retired the automations it no longer owns"
    );
  }

  const automationIdsAfter = [
    ...new Set([...attached, ...(input.automationIds ?? []), ...ownedAfter]),
  ];

  // ── Re-snapshot — the ONLY honest way to clear `diverged` ────────────────
  // Hashes the automations AS THEY NOW ARE, after this call rewrote them from
  // the rule's own sentence. Earned, not stamped.
  const behaviours = await snapshotBehaviours(automationIdsAfter);

  const metadata = buildRuleMetadata({
    intent,
    scope: input.scope,
    ...(expiresAt ? { expiresAt } : {}),
    ...(draft ? { draft: true } : {}),
    ...(input.factSkillId
      ? { factSkillId: input.factSkillId }
      : existing.factSkillId
        ? { factSkillId: existing.factSkillId }
        : {}),
    behaviours,
    routing,
    ...(sentenceInput !== undefined && sentenceInput !== null
      ? { sentence: sentenceInput }
      : {}),
  });
  // `createdAt` is the RULE's birthday, not this edit's. `buildRuleMetadata`
  // stamps `now`, which would silently reset it on every save.
  metadata.createdAt = existing.createdAt;

  await db
    .update(skills)
    .set({
      workspaceId: input.scope.kind === "workspace" ? workspaceId : null,
      scope: input.scope.kind,
      name: ruleNameFromIntent(intent),
      description: intent,
      // The rule's intent IS the fact an agent reads while reasoning — that is
      // why a rule lives in `skills`. Editing the prose must edit the body.
      body: intent,
      metadata: {
        ...((row.metadata as Record<string, unknown> | null) ?? {}),
        [RULE_METADATA_KEY]: metadata,
      },
      updatedAt: new Date(),
    })
    .where(eq(skills.id, input.ruleId));

  // Idempotent (the links unique edge absorbs a replay), so re-linking an
  // automation the rule already had is a no-op and a newly compiled one gains
  // its edge. NOT best-effort, for the same reason as on create: the edge is
  // the membership store, so a rule whose edge failed to write has silently
  // lost its behaviour.
  await linkRuleHalves({
    ruleSkillId: input.ruleId,
    ...(metadata.factSkillId ? { factSkillId: metadata.factSkillId } : {}),
    automationIds: automationIdsAfter,
    workspaceId,
  });

  return {
    status: "updated",
    ruleId: input.ruleId,
    automationIds: automationIdsAfter,
    draft,
    ...(scopeNote ? { scopeNote } : {}),
  };
}
