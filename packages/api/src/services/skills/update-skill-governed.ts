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
 */
import { and, db, eq, skills } from "@synap/database";
import { skillsRouter } from "../../routers/skills.js";
import { visibleSkillsAnyWorkspaceWhere } from "./visibility.js";

export interface SkillUpdatePatch {
  name?: string;
  description?: string;
  body?: string;
}

export type UpdateSkillGovernedResult =
  | { status: "not_found" }
  | { status: "updated"; skillId: string }
  | { status: "proposed"; skillId: string; proposalId: string };

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
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        id ? eq(skills.id, id) : eq(skills.slug, slug!),
        visibleSkillsAnyWorkspaceWhere(input.userId, { includeExpired: true })
      )
    )
    .limit(1);
  if (!row) return { status: "not_found" };

  const caller = skillsRouter.createCaller(input.callerCtx as never);
  const result = await caller.update({
    id: row.id,
    ...input.patch,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
  });
  if (result.status === "proposed") {
    return {
      status: "proposed",
      skillId: row.id,
      proposalId: result.proposalId,
    };
  }
  return { status: "updated", skillId: row.id };
}
