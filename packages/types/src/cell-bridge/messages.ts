/**
 * Every message a MODULE frame sends its host (the `SynapWidget` /
 * `SynapView` SDKs, `frame-sdks.ts`), parsed in one place. Ported from the
 * message unions of synap-app `packages/web/src/cell-runtime/
 * iframe-protocol.ts` (`WidgetMessage`) and the checks ViewFrame applied
 * inline. A host never reads `event.data` itself: it reads what this returns.
 *
 * The bridge messages (`synap:query`, `synap:mutate`) are parsed by
 * `parseCellBridgeMessage` (`protocol.ts`), the page frame's parser: the
 * bridge is a SUBSET of this protocol, with one rule for both.
 *
 * Anything else (another library's message, a malformed field, an unknown
 * type) is null: not ours, ignored.
 */

import {
  parseCellBridgeMessage,
  type CellBridgeFrameMessage,
} from "./protocol.js";

/** Where a frame asks the host to go (`SynapWidget.navigate`). */
export interface CellFrameNavigationTarget {
  type: "entity" | "view" | "channel" | "document" | "url";
  id?: string;
  url?: string;
}

/** What a frame asks the host to open (`SynapView.openSurface`, `synap.open`). */
export interface CellFrameSurfaceRequest {
  kind: string;
  [field: string]: unknown;
}

/** Frame → host: every message a module frame may send, validated. */
export type CellFrameHostMessage =
  | { type: "synap:ready" }
  | { type: "synap:mounted" }
  /** A height in px, in (0, 10000]. */
  | { type: "synap:resize"; height: number }
  /**
   * At most 500 characters. `reason` types the few errors a host answers
   * differently (`CELL_FRAME_ERROR_REASONS`); an unknown one is dropped.
   */
  | { type: "synap:error"; message: string; reason?: CellFrameErrorReason }
  | { type: "synap:navigate"; target: CellFrameNavigationTarget }
  | { type: "synap:toast"; message: string; level: "info" | "error" }
  | {
      type: "synap:open-panel";
      id: string;
      panelType: "entity" | "view" | "document";
      resourceId: string;
    }
  | { type: "synap:surface:open"; surface: CellFrameSurfaceRequest }
  | { type: "synap:context-update"; meta: Record<string, unknown> }
  | CellBridgeFrameMessage;

/**
 * Why a frame stopped, when the host should do more than show a failure:
 *   not-drawn  the renderer does not draw this object (a view type its cell
 *              has no drawing for): the host shows what it shows with no
 *              renderer (the object's identity card and its door to the app).
 */
export const CELL_FRAME_ERROR_REASONS = ["not-drawn"] as const;
export type CellFrameErrorReason = (typeof CELL_FRAME_ERROR_REASONS)[number];

/** The longest error a frame may report; a longer one is cut. */
export const CELL_FRAME_MAX_ERROR_CHARS = 500;
/** The longest toast a frame may show; a longer one is cut. */
export const CELL_FRAME_MAX_TOAST_CHARS = 300;
/** The tallest a frame may ask to be, in px. */
export const CELL_FRAME_MAX_HEIGHT = 10_000;

const NAVIGATION_TYPES = new Set([
  "entity",
  "view",
  "channel",
  "document",
  "url",
]);
const PANEL_TYPES = new Set(["entity", "view", "document"]);
const MAX_ID = 200;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const shortString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

function parseTarget(v: unknown): CellFrameNavigationTarget | null {
  if (!isPlainRecord(v)) return null;
  if (typeof v.type !== "string" || !NAVIGATION_TYPES.has(v.type)) return null;
  const target: CellFrameNavigationTarget = {
    type: v.type as CellFrameNavigationTarget["type"],
  };
  if (v.id !== undefined) {
    if (!shortString(v.id)) return null;
    target.id = v.id;
  }
  if (v.url !== undefined) {
    if (!isHttpsUrl(v.url)) return null;
    target.url = v.url;
  }
  return target;
}

/**
 * A URL a frame may ask the host to open: `https:` only, at most 2048
 * characters. `javascript:`, `data:`, `http:` and anything that does not
 * parse are refused, so a host that opens it can never run or downgrade it.
 */
function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** A frame message, validated, or null. */
export function parseCellFrameMessage(
  data: unknown
): CellFrameHostMessage | null {
  if (!isPlainRecord(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "synap:ready":
      return { type: "synap:ready" };
    case "synap:mounted":
      return { type: "synap:mounted" };
    case "synap:resize": {
      const height = Number(data.height);
      if (
        !Number.isFinite(height) ||
        height <= 0 ||
        height > CELL_FRAME_MAX_HEIGHT
      )
        return null;
      return { type: "synap:resize", height };
    }
    case "synap:error":
      return {
        type: "synap:error",
        message: cut(
          typeof data.message === "string" && data.message.trim()
            ? data.message
            : "The view reported an error.",
          CELL_FRAME_MAX_ERROR_CHARS
        ),
        ...((CELL_FRAME_ERROR_REASONS as readonly unknown[]).includes(
          data.reason
        )
          ? { reason: data.reason as CellFrameErrorReason }
          : {}),
      };
    case "synap:navigate": {
      const target = parseTarget(data.target);
      return target ? { type: "synap:navigate", target } : null;
    }
    case "synap:toast":
      if (typeof data.message !== "string" || !data.message.trim()) return null;
      return {
        type: "synap:toast",
        message: cut(data.message, CELL_FRAME_MAX_TOAST_CHARS),
        level: data.level === "error" ? "error" : "info",
      };
    case "synap:open-panel":
      if (
        typeof data.id !== "string" ||
        data.id.length > MAX_ID ||
        typeof data.panelType !== "string" ||
        !PANEL_TYPES.has(data.panelType) ||
        !shortString(data.resourceId)
      )
        return null;
      return {
        type: "synap:open-panel",
        id: data.id,
        panelType: data.panelType as "entity" | "view" | "document",
        resourceId: data.resourceId,
      };
    case "synap:surface:open":
      if (!isPlainRecord(data.surface) || typeof data.surface.kind !== "string")
        return null;
      return {
        type: "synap:surface:open",
        surface: data.surface as CellFrameSurfaceRequest,
      };
    case "synap:context-update":
      if (!isPlainRecord(data.meta)) return null;
      return { type: "synap:context-update", meta: data.meta };
    case "synap:query":
    case "synap:mutate":
    case "synap:context":
      return parseCellBridgeMessage(data);
    default:
      return null;
  }
}
