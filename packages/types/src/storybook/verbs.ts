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
export const STORYBOOK_CHANGED_DEFAULT = 50;

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
          "A pod file holding a synap.storybook-bundle/v1 JSON, uploaded by a computer (the path for a private Storybook). Give this or url, not both.",
      },
      url: {
        type: "string",
        format: "uri",
        description:
          "A public Storybook over https (its base URL). The pod reads index.json and, when present, manifests/components.json through its guarded fetch; the host must be on the pod's allow-list. Give this or bundleFileId, not both.",
      },
      appId: {
        type: "string",
        format: "uuid",
        description:
          "The app (devplane_app) these components and pages belong to: each record gets belongs_to it.",
      },
      brandIdentityId: {
        type: "string",
        format: "uuid",
        description: "The brand identity (brand-identity) this Storybook draws.",
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
        description: `How many to return (default ${STORYBOOK_CHANGED_DEFAULT}), most used first.`,
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
