/**
 * "Allow without review" on an agent-made verb (founder, 21 Nov 2026, answer
 * 11 of wave 9563b6f7; report 64a2f36b).
 *
 * A verb an agent makes with `create_verb` is reviewed on every call. At the
 * approval of THAT verb's own proposal the person may tick "allow without
 * review": the approval then also sets the verb's run mode to "runs on its
 * own" (`writeActionMode`): ONE `governance_rules` row, every AI × the whole
 * pod × this action by name → auto, authored by the person, its source the
 * verb's proposal. Nothing new is stored: it is the row the tool page shows as
 * "When an AI uses it" and takes back, and the row the capability gate reads.
 *
 * Only the person sets it:
 *   - the tick rides `proposals.approve`, which an agent's credential never
 *     reaches (`refuseAgentProposalApprover`), and an app's sign-in is refused
 *     here too (`assertPersonSetsActionMode`);
 *   - `create_verb` takes no such field (its input schema strips unknown keys),
 *     and an agent's proposed skill carries no `metadata` but a box's;
 *   - a rule written by an agent's credential is refused
 *     (`governanceRules.create`, `assertPersonSetsActionMode`).
 *
 * WHICH VERBS IT IS OFFERED FOR (the lead's default, named in the PR): a verb
 * that does not write outside the pod. The verb's request says so only in
 * part: GET / HEAD and a GraphQL `query` read; PUT / PATCH / DELETE and a
 * GraphQL `mutation` write. A POST (or a GraphQL operation it does not name)
 * cannot be told from the verb (the report's own verbs are POSTs that read),
 * so it is offered, and the card shows the request. A verb no rule may widen
 * (`capabilityVerbAllowsRuleWiden`: a public post, `metadata.proposeOnly`) is
 * never offered.
 */

import { TRPCError } from "@trpc/server";
import { capabilityVerbAllowsRuleWiden } from "@synap/governance-policy";
import { createLogger } from "@synap-core/core";
import { isPodAdmin } from "../../utils/workspace-role.js";
import {
  actionsMayRunOnTheirOwn,
  assertPersonSetsActionMode,
  writeActionMode,
} from "./action-mode.js";

const logger = createLogger({ module: "verb-allow" });

/** `cause.reasonCode` of an approve whose tick does not apply. */
export const VERB_ALLOW_NOT_OFFERED = "VERB_ALLOW_NOT_OFFERED";

/** The proposal columns this file reads. */
export interface VerbProposalRow {
  status: string;
  targetType: string;
  proposalType: string;
  agentUserId: string | null;
  data: unknown;
}

/** The verb an agent proposed to make: its name and its request. */
interface ProposedVerb {
  name: string;
  intent: string | null;
  metadata: Record<string, unknown> | null;
  providerSpec: Record<string, unknown>;
}

/** The declarative verb an agent's `skill/create` proposal makes, or null. */
export function proposedAgentVerb(p: VerbProposalRow): ProposedVerb | null {
  if (p.targetType !== "skill" || p.proposalType !== "create") return null;
  if (!p.agentUserId) return null;
  const inner = (p.data as { data?: unknown } | null)?.data;
  if (!inner || typeof inner !== "object") return null;
  const d = inner as Record<string, unknown>;
  if (d.kind !== "declarative") return null;
  const spec = d.providerSpec;
  if (!spec || typeof spec !== "object") return null;
  const tool = (spec as { tool?: unknown }).tool;
  if (typeof tool !== "string" || tool.trim() === "") return null;
  if (typeof d.name !== "string" || d.name.trim() === "") return null;
  return {
    name: d.name,
    intent: typeof d.intent === "string" ? d.intent : null,
    metadata:
      d.metadata && typeof d.metadata === "object"
        ? (d.metadata as Record<string, unknown>)
        : null,
    providerSpec: spec as Record<string, unknown>,
  };
}

/**
 * Does the verb's request say it writes outside the pod? Only what the
 * request states: PUT / PATCH / DELETE, or a GraphQL operation declared a
 * mutation. A POST, or a GraphQL operation it does not name, cannot be told.
 */
export function verbRequestWrites(spec: Record<string, unknown>): boolean {
  if (spec.transport === "graphql") {
    const op = (spec.graphql as { operation?: unknown } | undefined)?.operation;
    return op === "mutation";
  }
  return /^(PUT|PATCH|DELETE)$/i.test(String(spec.method ?? ""));
}

/**
 * The tick a card may offer on this proposal: the verb it would let run on
 * its own, or null. The ONE derivation the card reads (projected on
 * `proposals.get`) and the approve door enforces. Pending only: the tick
 * rides the approval.
 */
export function verbAllowOffer(p: VerbProposalRow): { verb: string } | null {
  if (p.status !== "pending") return null;
  const verb = proposedAgentVerb(p);
  if (!verb) return null;
  if (verbRequestWrites(verb.providerSpec)) return null;
  if (!capabilityVerbAllowsRuleWiden(verb.name, verb.intent, verb.metadata)) {
    return null;
  }
  return { verb: verb.name };
}

/**
 * Before anything is approved: the tick applies to this proposal, the caller
 * is a person (not an agent, not an app's sign-in) who runs the pod (the row
 * is pod-wide), and no verb already on the pod under that name forbids it.
 * Throws; returns the verb's name.
 */
export async function assertMayAllowVerbWithoutReview(
  ctx: { userId: string; agentUserId?: string | null; keyType?: string | null },
  proposal: VerbProposalRow
): Promise<string> {
  assertPersonSetsActionMode(ctx);
  const offer = verbAllowOffer(proposal);
  if (!offer) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "allowWithoutReview applies only to the pending proposal of a verb an AI made, when its request does not write outside the pod (not PUT, PATCH, DELETE or a GraphQL mutation) and it does not publish in public.",
      cause: { reasonCode: VERB_ALLOW_NOT_OFFERED },
    });
  }
  if (!(await isPodAdmin(ctx.userId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only a pod admin lets an action run without review for every AI on the pod. Approve without the tick, or ask a pod admin.",
    });
  }
  if (!(await actionsMayRunOnTheirOwn([offer.verb])).get(offer.verb)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `"${offer.verb}" publishes in public or cannot be undone: it always asks you first.`,
      cause: { reasonCode: VERB_ALLOW_NOT_OFFERED },
    });
  }
  return offer.verb;
}

/** What the approve answers about the tick. */
export type VerbAllowResult =
  { verb: string; ruleId: string | null } | { verb: string; failed: string };

/**
 * After the approval made the verb: set its run mode to "runs on its own",
 * the source being the verb's own proposal. A failure is REPORTED, never
 * thrown: the approval already stands, and the person can set the mode on the
 * tool page.
 */
export async function allowVerbWithoutReview(input: {
  userId: string;
  verb: string;
  proposalId: string;
}): Promise<VerbAllowResult> {
  try {
    const written = await writeActionMode({
      userId: input.userId,
      action: input.verb,
      mode: "auto",
      sourceProposalId: input.proposalId,
    });
    return { verb: input.verb, ruleId: written.ruleId };
  } catch (err) {
    logger.error(
      { proposalId: input.proposalId, verb: input.verb, err },
      "allow without review: the run mode was not set after the verb's approval"
    );
    return {
      verb: input.verb,
      failed:
        "The verb was approved, but it still asks before each run: set it to run on its own on its tool's page.",
    };
  }
}
