/**
 * A cell's CONTENT FINGERPRINT: what a person approves when they approve a
 * cell, as one sha256 (decision Q9, plan 9ad4b2fc lane 16: approval per
 * fingerprint; prior art Notion custom blocks and MCP Apps, where a stored
 * renderer is a fixed artifact, approved again on any change).
 *
 * The content is what the frame runs and what it may reach: the mechanism
 * (`rendererType`), the source, the runtime `deps` and the egress grant
 * (`externalHosts`). Name, icon, size and config are presentation: they do not
 * change what runs, so they are not in it.
 *
 * Two places carry it, computed by the same function:
 *   - a `cell/define` proposal, stamped into its payload as `contentSha256`
 *     (`withCellContentFingerprint`): by the governance gate when the
 *     proposal is filed, and again by the revise core on every revision. The
 *     approve executor refuses a payload whose fingerprint is not the stamped
 *     one: the payload was changed by a path that is not a door.
 *   - the stored row, `widget_definitions.content_sha256` (migration 0396),
 *     written by `defineCell`, the one writer, from the row as written. NULL =
 *     written before fingerprints, or replicated from another pod (`sync.ts`):
 *     content nobody approved on this pod.
 *
 * Backend only, on purpose: `@synap-core/types` subpaths are leaves with no
 * crypto (they ship to the browser and the frame kit), and no client reads
 * the fingerprint yet. The canonical form below is what a client would hash.
 */
import { createHash } from "node:crypto";
import { isHtmlPageSource } from "@synap-core/types/renderables";
import { stableStringify } from "../../utils/stable-stringify.js";

/** The payload key a `cell/define` proposal carries its fingerprint under. */
export const CELL_CONTENT_FINGERPRINT_KEY = "contentSha256" as const;

/**
 * The mechanisms a gated cell definition may carry, re-validated by the
 * approve executor. `native` and `mcp-app` are absent by construction.
 */
export const GATED_RENDERER_TYPES = ["builtin", "iframe", "frame"] as const;
export type GatedRendererType = (typeof GATED_RENDERER_TYPES)[number];

export interface CellContent {
  rendererType: string;
  rendererSource: string;
  deps?: Record<string, string> | null;
  externalHosts?: readonly string[] | null;
}

/** Bumped only if the canonical form changes; every stored value then reads as different. */
const FINGERPRINT_VERSION = 1;

/**
 * sha256 (hex) over the canonical form of a cell's content. Pure: key order,
 * the order of `externalHosts`, blank or repeated hosts, and an empty `deps`
 * vs none do not change it (none of them changes what the frame does).
 */
export function cellContentFingerprint(content: CellContent): string {
  const hosts = [
    ...new Set(
      (content.externalHosts ?? [])
        .filter((h): h is string => typeof h === "string")
        .map((h) => h.trim())
        .filter((h) => h !== "")
    ),
  ].sort();
  const canonical = stableStringify({
    v: FINGERPRINT_VERSION,
    rendererType: content.rendererType,
    rendererSource: content.rendererSource,
    deps: content.deps ?? {},
    externalHosts: hosts.length > 0 ? hosts : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The gated mechanism a payload names, or undefined when it names none (or one a gate may not carry). */
export function gatedRendererTypeOf(
  value: unknown
): GatedRendererType | undefined {
  return (GATED_RENDERER_TYPES as readonly string[]).includes(value as string)
    ? (value as GatedRendererType)
    : undefined;
}

/**
 * The content the `cell/define` approve executor materialises from this
 * payload (`applyCellDefineProposal`): the source, the mechanism it names or
 * the one `defineCell` derives from the source, and no `deps` or egress (the
 * executor passes neither; an agent never grants its own egress). Null when
 * the payload carries no source.
 */
export function proposedCellContent(
  payload: Record<string, unknown>
): CellContent | null {
  const rendererSource = payload.rendererSource;
  if (typeof rendererSource !== "string" || rendererSource === "") return null;
  return {
    rendererType:
      gatedRendererTypeOf(payload.rendererType) ??
      (isHtmlPageSource(rendererSource) ? "iframe" : "frame"),
    rendererSource,
    deps: null,
    externalHosts: null,
  };
}

/**
 * The payload with its fingerprint stamped (a copy; the input is never
 * mutated). A payload with no source comes back unchanged: there is nothing
 * to approve, and the executor refuses it anyway.
 */
export function withCellContentFingerprint<T extends Record<string, unknown>>(
  payload: T
): T & { [CELL_CONTENT_FINGERPRINT_KEY]?: string } {
  const content = proposedCellContent(payload);
  if (!content) return payload;
  return {
    ...payload,
    [CELL_CONTENT_FINGERPRINT_KEY]: cellContentFingerprint(content),
  };
}

/**
 * The stamp a payload carries, or null when it carries none (a proposal filed
 * before fingerprints, or a legacy `widget/register` one).
 */
export function stampedCellFingerprint(
  payload: Record<string, unknown>
): string | null {
  const stamp = payload[CELL_CONTENT_FINGERPRINT_KEY];
  return typeof stamp === "string" && stamp !== "" ? stamp : null;
}
