/**
 * The `storybook` capability's verbs, as the package declares them (plan
 * 48854969 §9). Their handlers are builtins of the pod
 * (`services/capabilities/builtin-verbs.ts`); the package that makes them
 * runnable lives in the one catalog home (app-bases
 * `packages/workspace-templates/capabilities/storybook.capability.json`).
 *
 * `STORYBOOK_VERB_PARAMETERS` is the ONE param contract: the package's
 * `skills[].parameters` must equal it (pinned on the app-bases side), and the
 * pod's catalog-coherence tripwire reads it as the catalog that advertises
 * these verbs, so a handler param the package does not advertise goes red.
 */

/** The catalog key of the capability package that carries the storybook verbs. */
export const STORYBOOK_CAPABILITY_KEY = "storybook";

export const STORYBOOK_SYNC_VERB = "storybook.sync";
export const STORYBOOK_CHANGED_VERB = "storybook.changed";

export const STORYBOOK_VERBS = [
  STORYBOOK_SYNC_VERB,
  STORYBOOK_CHANGED_VERB,
] as const;
export type StorybookVerb = (typeof STORYBOOK_VERBS)[number];

/** A JSON-schema object, as a capability skill's `parameters` carries it. */
export interface StorybookVerbParameters {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

/** `storybook.changed` returns at most this many, and this many when no `limit` is given. */
export const STORYBOOK_CHANGED_MAX = 200;
export const STORYBOOK_CHANGED_DEFAULT = 20;

export const STORYBOOK_VERB_PARAMETERS: Readonly<
  Record<StorybookVerb, StorybookVerbParameters>
> = {
  [STORYBOOK_SYNC_VERB]: {
    type: "object",
    properties: {
      bundleFileId: {
        type: "string",
        format: "uuid",
        description:
          "A pod file holding a synap.storybook-bundle/v1 JSON (the devbox uploads it after each main push). Give this or url.",
      },
      url: {
        type: "string",
        format: "uri",
        description:
          "A public Storybook's https base URL, instead of bundleFileId: the pod reads its index.json and, when served, manifests/components.json (props) through its guarded fetch, on a host the pod allows.",
      },
      appId: {
        type: "string",
        format: "uuid",
        description:
          "The app (devplane_app) these components, pages and flows belong to.",
      },
      brandIdentityId: {
        type: "string",
        format: "uuid",
        description:
          "The brand identity (brand-identity) the Storybook expresses.",
      },
    },
    additionalProperties: false,
  },
  [STORYBOOK_CHANGED_VERB]: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: STORYBOOK_CHANGED_MAX,
        description: `At most this many components (default ${STORYBOOK_CHANGED_DEFAULT}).`,
      },
      appId: {
        type: "string",
        format: "uuid",
        description: "Only this app's components.",
      },
    },
    additionalProperties: false,
  },
};
