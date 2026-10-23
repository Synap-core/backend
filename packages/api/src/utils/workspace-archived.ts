/**
 * THE listing rule for archived spaces: a space whose `archivedAt` is set is
 * left out of a listing unless the caller asked for archived ones.
 *
 * One predicate for every door that LISTS spaces — `workspaces.list` (and so
 * `synap_list_workspaces`, Hub `GET /workspaces`) and orient (`discover`).
 * They used to disagree: orient listed an archived space (live 2026-10-20,
 * "Radar") that `synap_list_workspaces` correctly hid, so an agent was offered
 * an archived space to write into.
 *
 * A listing rule, not access: an archived space stays readable by id.
 */
export function isHiddenAsArchived(
  workspace: { archivedAt?: Date | string | null },
  opts: { includeArchived?: boolean } = {}
): boolean {
  return opts.includeArchived !== true && workspace.archivedAt != null;
}
