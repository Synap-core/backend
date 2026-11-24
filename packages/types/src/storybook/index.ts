/**
 * `@synap-core/types/storybook` — a Storybook as data: the ONE parser of its
 * `index.json` and `manifests/components.json`, the
 * `synap.storybook-bundle/v1` format the pod's `storybook` sync mirrors into
 * `ui-component`, `ui-page` and `user-flow` records (with its validator and
 * identity rule), `bundleFromStorybook` for a public Storybook, and the
 * `storybook` capability's verb contract. Plan 48854969 §9.
 *
 * One home for app-bases (the design catalog generator, the Design app's Map,
 * the devbox bundle builder) and the pod's sync, so a Storybook is read one
 * way everywhere. Pure and dependency-free: no I/O.
 */
export {
  describeProblems,
  hasErrors,
  type StorybookProblem,
  type StorybookProblemCode,
  type StorybookRead,
} from "./problems.js";
export * from "./sources.js";
export * from "./hash.js";
export * from "./bundle.js";
export * from "./from-storybook.js";
export * from "./verbs.js";
