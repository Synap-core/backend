/**
 * Routable / domain-home workspace predicates — thin re-exports.
 *
 * Implementations live in @synap/database so the placement door and api-side
 * candidate-list builders share ONE definition. Prefer
 * `isDomainHomeWorkspace` when settings/systemSlug are available (catches
 * admin surfaces mis-typed as personal).
 */
export {
  isRoutableWorkspaceType,
  isDomainHomeWorkspace,
  DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
  type WorkspaceHomeSignals,
} from "@synap/database";
