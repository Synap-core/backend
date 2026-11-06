/**
 * The agent → template link (`users.agent_template_slug`), written in ONE
 * place.
 *
 * Who writes it:
 *   - the connect door, with the template `synap agents add` names (founder
 *     decision D9): applied by the SAME approval that connects the agent (the
 *     `agent/connect` proposal), or at once when a person connects it with
 *     their own key. Never a second approval, never without the first;
 *   - the self-healing pass (D10), for an agent whose program is clear.
 * An agent key never writes it: no door takes it from an agent.
 *
 * A link is written only where there is none: a re-connect, or a clear match
 * found later, never re-points an agent a person (or an earlier connect)
 * already linked.
 */

import { and, db, drizzleSql, eq, isNull } from "@synap/database";
import { agentTemplates, users } from "@synap/database/schema";
import { AGENT_TEMPLATE_SLUG } from "@synap-core/types/agents";

/**
 * Check the template a connect names against the agent's type. A slug that is
 * not installed yet is accepted, and links nothing (`linkAgentToTemplate`):
 * an older catalog, or a pod whose catalog has not installed it yet, never
 * fails a connect. Returns the refusal sentence, or null.
 */
export async function checkConnectTemplate(
  template: unknown,
  agentType: string
): Promise<string | null> {
  if (typeof template !== "string" || !AGENT_TEMPLATE_SLUG.test(template)) {
    return "`template` must be an agent template slug (kebab-case), e.g. claude-code.";
  }
  const [row] = await db
    .select({
      harness: agentTemplates.harness,
      aliases: agentTemplates.aliases,
      name: agentTemplates.name,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.slug, template))
    .limit(1);
  if (!row) return null;
  const aliases = Array.isArray(row.aliases) ? row.aliases : [];
  if (row.harness === agentType || aliases.includes(agentType)) return null;
  return `The ${row.name} template is for agents of type "${row.harness}", not "${agentType}".`;
}

/**
 * Link an agent to an INSTALLED template when it has no link yet. True =
 * written. A slug that is not installed links nothing: a link never dangles,
 * so a connect that named a template the pod does not have yet leaves the
 * agent to the self-healing pass, which links it once the catalog installs it.
 */
export async function linkAgentToTemplate(
  agentUserId: string,
  templateSlug: string
): Promise<boolean> {
  const written = await db
    .update(users)
    .set({ agentTemplateSlug: templateSlug })
    .where(
      and(
        eq(users.id, agentUserId),
        isNull(users.agentTemplateSlug),
        drizzleSql`EXISTS (SELECT 1 FROM ${agentTemplates} WHERE ${agentTemplates.slug} = ${templateSlug})`
      )
    )
    .returning({ id: users.id });
  return written.length > 0;
}
