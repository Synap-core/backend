/**
 * THE HAND-OFF PLAYBOOK of a binding — the playbook a person's "give this to
 * <agent>" runs when the agent is reached by DISPATCH (a binding), not by
 * check-in.
 *
 * Derived from data, never named in code: the binding's tool and the playbook
 * are parts of the SAME installed capability (`tool --member_of--> capability
 * <--member_of-- playbook`, both written by `createCapabilityFromDefinition`),
 * and the playbook runs on the `external-agent` executor. So the provider
 * template that ships the binding also ships the act of handing work to it
 * (e.g. `claude-code-routines` → "Hand off to Claude Code"); a person can edit
 * it like any playbook.
 *
 * `null` = the binding's capability ships no active hand-off playbook. The
 * caller says so — it never falls back to filing work the agent will not read.
 * Several (a template that ships more than one) ⇒ the oldest, so the answer is
 * stable.
 */

import {
  db,
  and,
  eq,
  asc,
  drizzleSql,
  links,
  playbooks,
} from "@synap/database";

export interface HandOffPlaybook {
  id: string;
  name: string;
  /** The playbook's workspace — the lens its run is filed in (`null` = pod-wide). */
  workspaceId: string | null;
}

export async function findHandOffPlaybook(
  toolId: string
): Promise<HandOffPlaybook | null> {
  const toolCaps = db
    .select({ capabilityId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "tool"),
        eq(links.fromId, toolId),
        eq(links.toType, "capability"),
        eq(links.linkType, "member_of")
      )
    );
  const [row] = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      workspaceId: playbooks.workspaceId,
    })
    .from(links)
    .innerJoin(playbooks, drizzleSql`${playbooks.id}::text = ${links.fromId}`)
    .where(
      and(
        eq(links.fromType, "playbook"),
        eq(links.toType, "capability"),
        eq(links.linkType, "member_of"),
        drizzleSql`${links.toId} IN ${toolCaps}`,
        eq(playbooks.executor, "external-agent"),
        eq(playbooks.status, "active")
      )
    )
    .orderBy(asc(playbooks.createdAt))
    .limit(1);
  return row ?? null;
}
