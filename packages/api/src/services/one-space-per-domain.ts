/**
 * ONE SPACE PER DOMAIN — the lens rule, worded ONCE.
 *
 * A space (workspace) is a DOMAIN installed once from its template; a project
 * is a FILTER across spaces (`project --uses--> workspace` index + each
 * entity's `belongs_to_project`). "Brand for Architech" is the Brand space
 * filtered by the Architech project — never a second Brand space.
 *
 * Every AI door carries this wording:
 *   - `ONE_SPACE_PER_DOMAIN_RULE`   — the full rule: the skills that route
 *     domain/project creation (`lenses`, `from-intent`, `workspace-design`,
 *     `agent-os`), the IS workspace-design prompt section, and the guidance a
 *     refused / noted create returns (`checkOneSpacePerDomain`).
 *   - `ONE_SPACE_PER_DOMAIN_REFLEX` — the budgeted one-liner in the MCP
 *     `instructions` field (`skills/synap/reflexes.md`, 2 KB budget).
 * Pinned by `one-space-per-domain.tripwire.test.ts`, which derives the doors it
 * scans (every skill topic that teaches workspace creation + the live MCP
 * instructions for every key profile) rather than listing them.
 */

export const ONE_SPACE_PER_DOMAIN_RULE =
  "A space is a domain, installed once (Content, Brand, CRM…). A project is a filter across spaces. To make something “for project X”: file it into X inside the domain's space (`file_into_project`), and link X to the space (`project_use_workspace`). Never create a space named after a project, a brand or a client.";

export const ONE_SPACE_PER_DOMAIN_REFLEX =
  "**One space per domain** (Content, Brand, CRM…), installed once; a project filters it: `file_into_project` + `project_use_workspace`. Never a space named after a project, brand or client.";

/** The guidance a create that would mint a second domain space carries. */
export function oneSpacePerDomainGuidance(existing: {
  workspaceId: string;
  name: string;
}): string {
  return `The "${existing.name}" space (${existing.workspaceId}) already holds this domain — use it, and scope by project: \`project_use_workspace\` links the project to it, \`file_into_project\` (or a write's \`projectId\`, which files it \`belongs_to_project\`) puts each item in the project. ${ONE_SPACE_PER_DOMAIN_RULE}`;
}
