/**
 * The design door's three verbs, as the `design` capability package declares
 * them (plan 0fc746f4 §2.6). Their handlers are builtins of the pod
 * (`services/capabilities/builtin-verbs.ts`); the package that makes them
 * runnable lives in the one catalog home (app-bases
 * `packages/workspace-templates/capabilities/design.capability.json`).
 *
 * `DESIGN_VERB_PARAMETERS` is the ONE param contract: the package's
 * `skills[].parameters` must equal it (pinned on the app-bases side), and the
 * pod's catalog-coherence tripwire reads it as the catalog that advertises
 * these verbs, so a handler param the package does not advertise goes red.
 */

export const DESIGN_READ_VERB = "design.read";
export const DESIGN_CATALOG_VERB = "design.catalog";
export const DESIGN_APPLY_VERB = "design.apply";

export const DESIGN_VERBS = [
  DESIGN_READ_VERB,
  DESIGN_CATALOG_VERB,
  DESIGN_APPLY_VERB,
] as const;
export type DesignVerb = (typeof DESIGN_VERBS)[number];

/** A JSON-schema object, as a capability skill's `parameters` carries it. */
export interface DesignVerbParameters {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export const DESIGN_VERB_PARAMETERS: Readonly<
  Record<DesignVerb, DesignVerbParameters>
> = {
  [DESIGN_READ_VERB]: {
    type: "object",
    properties: {
      designId: {
        type: "string",
        format: "uuid",
        description: "The ui-design to read.",
      },
    },
    required: ["designId"],
    additionalProperties: false,
  },
  [DESIGN_CATALOG_VERB]: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  [DESIGN_APPLY_VERB]: {
    type: "object",
    properties: {
      designId: {
        type: "string",
        format: "uuid",
        description:
          "The ui-design to change. Omit it only when the first op is create_design.",
      },
      baseUpdatedAt: {
        type: "string",
        description:
          "The design's updatedAt as design.read returned it. Required with designId: a design changed since is refused (conflict), never overwritten.",
      },
      ops: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "object" },
        description:
          "The ops, applied in order, all or nothing: create_design {title, appId?, projectId?} (first only), add_frame {preset, name?, id?, pageOf?, x?, y?}, update_frame {frameId, name?, preset?, x?, y?, w?, h?}, remove_frame {frameId}, add_block {frameId, parentId?, slot?, index?, type, props?}, update_block {id, props?, unset?}, move_block {id, frameId?, parentId?, slot?, index?}, remove_block {id}, set_span {id, class, span}, set_hide {id, class, hide}, replace_page {frameId, page}, replace_board {board}.",
      },
      acceptDrops: {
        type: "boolean",
        description:
          "The stored design has parts the catalog cannot place (design.read lists them as `dropped`): true writes the design without them. Without it such a write is refused.",
      },
    },
    required: ["ops"],
    additionalProperties: false,
  },
};
