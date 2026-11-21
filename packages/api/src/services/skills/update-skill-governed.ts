/**
 * Update a skill by id OR slug through the ONE governed skill-update door —
 * `skillsRouter.update` (routers/skills.ts): `checkPermissionOrPropose`, the
 * owner/pod access floor, and the re-approval reset (an AGENT that submits an
 * `instruction` skill's `body` re-earns approval, because that body lands
 * verbatim in an agent's system prompt).
 *
 * Shared by the Hub REST `PATCH /agent-skills/:slug` door and the MCP
 * `synap_update_skill` tool. The REST door used to be a bare
 * `db.update(skills).where(slug)` behind a scope check: any `hub-protocol.write`
 * key could rewrite an APPROVED skill's body and it stayed live. Neither door
 * writes the table itself any more.
 *
 * A CODE skill's execution fields (`code`, `parameters`, `timeoutSeconds`,
 * `requiredTools`) ride the same door (ticket 01fc187c): `skills.update`
 * already resets approval when one of them changes and the `skill/update`
 * replay re-derives that reset, so an edit to what a skill runs is never live
 * until it is approved again.
 *
 * `category` rides it too (decision D1, proposal 8d04d49e): `category: "rule"`
 * makes an instruction skill a rule, pushed into every piece of work in its
 * scope. Same gate as every other field; `skillCategoryChangeProblem` is the
 * one check, shared with `skills.update`.
 */
import { and, db, eq, skills } from "@synap/database";
import { skillKindAfterUpdate, skillsRouter } from "../../routers/skills.js";
import {
  RULE_CATEGORY,
  ruleOverTierWarning,
  skillCategoryChangeProblem,
} from "../rules/index.js";
import { resolveRequiredToolNames } from "./required-tool-names.js";
import { visibleSkillsAnyWorkspaceWhere } from "./visibility.js";

export interface SkillUpdatePatch {
  name?: string;
  description?: string;
  body?: string;
  /** The new executable, whole (empty clears it: the skill becomes doc-only). */
  code?: string;
  parameters?: Record<string, unknown>;
  timeoutSeconds?: number;
  /** Tool NAMES, resolved under the skill's own workspace lens. The set
   *  REPLACES the declared one. */
  requiredTools?: string[];
  /** `"rule"` = a guideline pushed into every piece of work in its scope
   *  (instruction skills only); any other value is a free-form tag. */
  category?: string;
  /** The agent types the skill reaches; null = every agent. */
  agentTypes?: string[] | null;
  /** WHY this edit — shown to the reviewer when an agent's edit is proposed. */
  reasoning?: string;
}

export type UpdateSkillGovernedResult =
  | { status: "not_found" }
  /** Refused before the gate, in words the caller can act on. */
  | { status: "invalid"; message: string }
  | { status: "updated"; skillId: string; warnings?: string[] }
  | {
      status: "proposed";
      skillId: string;
      proposalId: string;
      warnings?: string[];
    };

export async function updateSkillGoverned(input: {
  /** A tRPC caller context for the acting person (e.g. createHubProtocolCallerContext). */
  callerCtx: unknown;
  userId: string;
  /** The acting agent, when an agent key made the call. Forwarded so the
   *  governed door applies the agent re-approval reset. */
  agentUserId?: string | null;
  /** `id` wins when both are given. */
  ref: { id?: string; slug?: string };
  patch: SkillUpdatePatch;
}): Promise<UpdateSkillGovernedResult> {
  const { id, slug } = input.ref;
  if (!id && !slug) return { status: "not_found" };

  // Owner-facing edit door: an expired rule must stay editable (renewable), so
  // expiry is waived here — this lookup feeds a write, never a prompt.
  const [row] = await db
    .select({
      id: skills.id,
      kind: skills.kind,
      workspaceId: skills.workspaceId,
      category: skills.category,
      metadata: skills.metadata,
      name: skills.name,
      body: skills.body,
    })
    .from(skills)
    .where(
      and(
        id ? eq(skills.id, id) : eq(skills.slug, slug!),
        visibleSkillsAnyWorkspaceWhere(input.userId, { includeExpired: true })
      )
    )
    .limit(1);
  if (!row) return { status: "not_found" };

  const { requiredTools, ...patch } = input.patch;
  // A prose skill is not turned into a runnable one by an edit: the router
  // keeps its kind (`skillKindAfterUpdate`), so the code would sit under an
  // `instruction` label that every review reads as prose.
  if (patch.code?.trim() && row.kind === "instruction") {
    return {
      status: "invalid",
      message:
        "This skill is documentation only (an instruction skill): it carries no code. Create a code skill with synap_create_skill instead.",
    };
  }
  const categoryProblem = skillCategoryChangeProblem({
    nextCategory: patch.category,
    currentCategory: row.category,
    metadata: row.metadata,
    kind: skillKindAfterUpdate(patch, row.kind),
    currentKind: row.kind,
  });
  if (categoryProblem) return { status: "invalid", message: categoryProblem };
  let requiredToolIds: string[] | undefined;
  if (requiredTools !== undefined) {
    const resolved = await resolveRequiredToolNames({
      userId: input.userId,
      names: requiredTools,
      workspaceId: row.workspaceId,
    });
    if ("error" in resolved) {
      return { status: "invalid", message: resolved.error };
    }
    requiredToolIds = resolved.ids;
  }

  const caller = skillsRouter.createCaller(input.callerCtx as never);
  const result = await caller.update({
    id: row.id,
    ...patch,
    ...(requiredToolIds !== undefined ? { requiredToolIds } : {}),
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
  });
  // A rule's words go into every piece of work in its scope, inside a fixed
  // tier: say so when they cannot fit. A warning, never a refusal.
  const resultingCategory = patch.category ?? row.category;
  const overTier =
    resultingCategory === RULE_CATEGORY
      ? ruleOverTierWarning(patch.name ?? row.name, patch.body ?? row.body)
      : null;
  const warnings = overTier ? { warnings: [overTier] } : {};
  if (result.status === "proposed") {
    return {
      status: "proposed",
      skillId: row.id,
      proposalId: result.proposalId,
      ...warnings,
    };
  }
  return { status: "updated", skillId: row.id, ...warnings };
}
