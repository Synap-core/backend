import { visit } from "unist-util-visit";
import type { Node } from "unist";
import { readEmbed } from "./embeds.js";

/**
 * The directives the read path understands, and the attributes each one may
 * carry. Documents are AI- and user-authored, so attributes are an ALLOWLIST:
 * anything not listed here is dropped rather than forwarded as a component
 * prop. Adding a directive = adding a row, never another branch.
 *
 * `cellProps` / `data-cell-props` are LEGACY props channels: they are still
 * read (every stored report uses them) but never written — `serializeEmbed`
 * puts props in a ```json block inside the directive instead.
 */
export const DIRECTIVE_ATTRIBUTES = {
  "synap-entity": ["id"],
  "synap-view": ["viewId", "viewType", "data-view-id"],
  "synap-cell": [
    "instanceId",
    "cellKey",
    "cellProps",
    "data-instance-id",
    "data-cell-key",
    "data-cell-props",
  ],
  // A report section — one attributable unit of AI authorship.
  "synap-section": [
    "id",
    "agent",
    "round",
    "skills",
    "confidence",
    "stepRunId",
    "nodeId",
    "status",
    // Session-document narrative stamps (synap-backend
    // services/session-document): who may rewrite the section (`ai` | `human`),
    // who wrote it, when, and the session state it was written against.
    "owner",
    "author",
    "writtenAt",
    "sessionState",
  ],
} as const satisfies Record<string, readonly string[]>;

export type SynapDirectiveName = keyof typeof DIRECTIVE_ATTRIBUTES;

/** Legacy attribute channels for embed props (read, never written). */
export const LEGACY_PROPS_ATTRIBUTES = [
  "cellProps",
  "data-cell-props",
] as const;

/**
 * Map every registered `:::name{…}` directive onto a same-named hast element
 * whose properties are the allowlisted attributes only.
 *
 * An EMBED's props are normalized here, once, through `readEmbed`: the props
 * block (```json, first child) is removed from the rendered children and handed
 * to the element as `cellProps` (a JSON string, whatever channel it came from),
 * and a malformed props value becomes `data-props-error` so the renderer shows
 * it instead of drawing the cell with an empty config. The children left on
 * the element are the author's markdown FALLBACK.
 */
export function remarkSynapDirectives() {
  return (tree: Node) => {
    visit(
      tree,
      ["textDirective", "leafDirective", "containerDirective"],
      (node: any) => {
        const allowed = (
          DIRECTIVE_ATTRIBUTES as Record<string, readonly string[]>
        )[node.name];
        if (!allowed) return;

        const attributes = (node.attributes ?? {}) as Record<string, unknown>;
        const hProperties: Record<string, unknown> = {};
        for (const key of allowed) {
          if (attributes[key] != null) hProperties[key] = attributes[key];
        }

        const embed = readEmbed(node);
        if (embed) {
          for (const key of LEGACY_PROPS_ATTRIBUTES) delete hProperties[key];
          if (embed.props) hProperties.cellProps = JSON.stringify(embed.props);
          if (embed.propsError)
            hProperties["data-props-error"] = embed.propsError;
          if (node.type === "containerDirective")
            node.children = embed.fallback;
        }

        const data = node.data || (node.data = {});
        data.hName = node.name;
        data.hProperties = hProperties;
      }
    );
  };
}
