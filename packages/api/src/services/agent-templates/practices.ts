/**
 * A template's practices, attached to the agent linked to it (lane D, D4).
 *
 * When an agent is linked to its template (`linkAgentToTemplate`: the connect
 * door, the self-healing pass, the person's answer to the "Which program is
 * each agent?" card), the template's `practices.skills` are written to the
 * agent through the ONE per-agent store: an `agent_configs` preset row
 * (0390, the shape `putAgentPreset` writes), key `template`, labelled
 * "From the <name> template".
 *
 * Written only where the agent has no `template` preset: a second link pass
 * writes nothing, and a person's edit of that preset is kept. The template's
 * practices ARE the list (today `synap` for every official template): a new
 * worker skill is a catalog edit, never code here.
 *
 * Agents linked before this existed get the same row from migration 0406,
 * once: a pass that re-attached it every time would bring back a preset a
 * person deleted.
 */

import { db as defaultDb, eq, isNotNull } from "@synap/database";
import { agentConfigs, agentTemplates, users } from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The preset key a template's practices are attached under. */
export const TEMPLATE_PRESET_KEY = "template";

/** How the person sees the preset: "From the Claude Code template". */
export function templatePresetLabel(templateName: string): string {
  return `From the ${templateName} template`;
}

/**
 * Attach the template's practices to the agent as its `template` preset, when
 * it has none. True = written. Runs inside the link's transaction, so a link
 * is never left without its practices.
 */
export async function attachTemplatePractices(
  tx: Db | Tx,
  agentUserId: string,
  templateSlug: string
): Promise<boolean> {
  const [agent] = await tx
    .select({ agentType: users.agentType })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  // A computer takes no preset (`putAgentPreset` refuses it the same way).
  if (!agent?.agentType || agent.agentType === MACHINE_AGENT_TYPE) return false;
  const [template] = await tx
    .select({ name: agentTemplates.name, practices: agentTemplates.practices })
    .from(agentTemplates)
    .where(eq(agentTemplates.slug, templateSlug))
    .limit(1);
  if (!template) return false;
  const skills = [...new Set(template.practices?.skills ?? [])];
  const written = await tx
    .insert(agentConfigs)
    .values({
      userId: agentUserId,
      workspaceId: null,
      agentType: agent.agentType,
      presetKey: TEMPLATE_PRESET_KEY,
      presetLabel: templatePresetLabel(template.name),
      skillSlugs: skills,
    })
    .onConflictDoNothing({
      target: [agentConfigs.userId, agentConfigs.presetKey],
      where: isNotNull(agentConfigs.presetKey),
    })
    .returning({ id: agentConfigs.id });
  return written.length > 0;
}
