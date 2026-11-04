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
 * Two places carry it, computed by the same function over the same resolved
 * content (the payload as the row it writes keeps it, `proposedCellContent`):
 *   - a `cell/define` proposal, stamped into its payload as `contentSha256`
 *     (`stampCellDefinePayload`): by the governance gate when the proposal is
 *     filed, and again by the revise core on every revision. The approve
 *     executor refuses a payload whose fingerprint is not the stamped one: the
 *     payload, or the row it writes, changed since by a path that is no door.
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
 * What a write that is silent on the mechanism and the egress KEEPS from the
 * stored row (`defineCell`'s omit-is-silence): a `builtin` / `mcp-app` row
 * keeps its mechanism, and the stored egress grant stays. Null = no row yet.
 */
export interface StoredCellContent {
  rendererType: string | null;
  externalHosts: readonly string[] | null;
}

/**
 * The content the `cell/define` approve executor materialises from this
 * payload (`applyCellDefineProposal`), resolved against the row it writes the
 * way `defineCell` resolves it: the mechanism the payload names, else the one
 * a stored `builtin` / `mcp-app` row keeps, else the one derived from the
 * source; no `deps` (the executor passes none, `defineCell` writes `{}`); and
 * the stored egress grant, which a write naming none keeps (an agent never
 * grants its own egress, and never drops an operator's). The SAME resolution
 * stamps the proposal and checks it at approval, so the stamp is the
 * fingerprint the approval writes to the row (`content_sha256`). Null when the
 * payload carries no source.
 */
export function proposedCellContent(
  payload: Record<string, unknown>,
  stored: StoredCellContent | null = null
): CellContent | null {
  const rendererSource = payload.rendererSource;
  if (typeof rendererSource !== "string" || rendererSource === "") return null;
  const derived = isHtmlPageSource(rendererSource) ? "iframe" : "frame";
  const kept =
    stored?.rendererType &&
    stored.rendererType !== "frame" &&
    stored.rendererType !== "iframe"
      ? stored.rendererType
      : undefined;
  return {
    rendererType: gatedRendererTypeOf(payload.rendererType) ?? kept ?? derived,
    rendererSource,
    deps: null,
    externalHosts: stored?.externalHosts ?? null,
  };
}

/**
 * The payload with its fingerprint stamped (a copy; the input is never
 * mutated), resolved against `stored`, the row its approval writes
 * (`stampCellDefinePayload` in `define-cell.ts` reads it). A payload with no
 * source comes back unchanged: there is nothing to approve, and the executor
 * refuses it anyway.
 */
export function withCellContentFingerprint<T extends Record<string, unknown>>(
  payload: T,
  stored: StoredCellContent | null = null
): T & { [CELL_CONTENT_FINGERPRINT_KEY]?: string } {
  const content = proposedCellContent(payload, stored);
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
