/**
 * Pick targets — the ONE description of "the thing the person pointed at".
 *
 * A person presses the pick chord, points at something on screen, and asks an
 * agent about it. Whatever they pointed at is described here, as identity only
 * (ids + a short title), never as content. The same shape is read by the
 * desktop picker (which stamps it on the DOM), by the companion turn context,
 * and — next — by the router that decides which agent can change the thing.
 *
 * Why not widen `ObjectCommentAnchorSchema`: that union says what a COMMENT may
 * be anchored to, and the pod authority-checks it on every write. A shape or a
 * piece of app chrome is pointable, not commentable. The two members that ARE
 * shared (`entity`, `document` with a heading/quote) keep the comment anchor's
 * field names so a target can become an anchor without translation.
 */

import { resolveObjectNoun } from "../vocabulary/index.js";

export const PICK_TARGET_KINDS = [
  "entity",
  "document",
  "cell",
  "widget",
  "view_row",
  "shape",
  "app_ui",
  "web",
] as const;

export type PickTargetKind = (typeof PICK_TARGET_KINDS)[number];

/** Where a cell's source lives — decides who can change it. */
export type CellProvenance = "builtin" | "stored";

/** A source location stamped by the dev build (`file:line:col`). */
export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
}

interface TargetBase {
  /** Short human title of the thing (an entity name, a heading, a page title). */
  title?: string;
}

export type PickTarget = TargetBase &
  (
    | { kind: "entity"; entityId: string; profileSlug?: string }
    | {
        kind: "document";
        documentId: string;
        /** Same fields as the comment anchor's block reference. */
        heading?: string;
        quote?: string;
      }
    | {
        kind: "cell";
        cellKey: string;
        instanceId?: string;
        provenance: CellProvenance;
      }
    | {
        kind: "widget";
        blockId: string;
        dashboardId?: string;
        cellKey?: string;
      }
    | { kind: "view_row"; viewId: string; entityId: string }
    | {
        kind: "shape";
        shapeId: string;
        shapeType: string;
        boardId?: string;
        entityId?: string;
        cellKey?: string;
      }
    | {
        kind: "app_ui";
        appId?: string;
        surfaceId?: string;
        source?: SourceLocation;
      }
    | { kind: "web"; url: string; tabId?: string; text?: string }
  );

const MAX_ID = 200;
const MAX_TEXT = 300;

function str(value: unknown, max = MAX_ID): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;
}

function req(value: unknown): string | null {
  return str(value) ?? null;
}

/**
 * Validate an untrusted target (a DOM stamp, an IPC payload). Returns null when
 * the kind is unknown or a required id is missing — never a half-built target.
 * Unknown fields are dropped; strings are bounded.
 */
export function parsePickTarget(raw: unknown): PickTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const title = str(r["title"], MAX_TEXT);
  const base = title ? { title } : {};
  switch (r["kind"]) {
    case "entity": {
      const entityId = req(r["entityId"]);
      if (!entityId) return null;
      const profileSlug = str(r["profileSlug"]);
      return {
        ...base,
        kind: "entity",
        entityId,
        ...(profileSlug ? { profileSlug } : {}),
      };
    }
    case "document": {
      const documentId = req(r["documentId"]);
      if (!documentId) return null;
      const heading = str(r["heading"], MAX_TEXT);
      const quote = str(r["quote"], MAX_TEXT);
      return {
        ...base,
        kind: "document",
        documentId,
        ...(heading ? { heading } : {}),
        ...(quote ? { quote } : {}),
      };
    }
    case "cell": {
      const cellKey = req(r["cellKey"]);
      const provenance = r["provenance"];
      if (!cellKey || (provenance !== "builtin" && provenance !== "stored")) {
        return null;
      }
      const instanceId = str(r["instanceId"]);
      return {
        ...base,
        kind: "cell",
        cellKey,
        provenance,
        ...(instanceId ? { instanceId } : {}),
      };
    }
    case "widget": {
      const blockId = req(r["blockId"]);
      if (!blockId) return null;
      const dashboardId = str(r["dashboardId"]);
      const cellKey = str(r["cellKey"]);
      return {
        ...base,
        kind: "widget",
        blockId,
        ...(dashboardId ? { dashboardId } : {}),
        ...(cellKey ? { cellKey } : {}),
      };
    }
    case "view_row": {
      const viewId = req(r["viewId"]);
      const entityId = req(r["entityId"]);
      if (!viewId || !entityId) return null;
      return { ...base, kind: "view_row", viewId, entityId };
    }
    case "shape": {
      const shapeId = req(r["shapeId"]);
      const shapeType = req(r["shapeType"]);
      if (!shapeId || !shapeType) return null;
      const boardId = str(r["boardId"]);
      const entityId = str(r["entityId"]);
      const cellKey = str(r["cellKey"]);
      return {
        ...base,
        kind: "shape",
        shapeId,
        shapeType,
        ...(boardId ? { boardId } : {}),
        ...(entityId ? { entityId } : {}),
        ...(cellKey ? { cellKey } : {}),
      };
    }
    case "app_ui": {
      const appId = str(r["appId"]);
      const surfaceId = str(r["surfaceId"]);
      const source = parseSourceLocation(r["source"]);
      return {
        ...base,
        kind: "app_ui",
        ...(appId ? { appId } : {}),
        ...(surfaceId ? { surfaceId } : {}),
        ...(source ? { source } : {}),
      };
    }
    case "web": {
      const url = req(r["url"]);
      if (!url || !/^https?:\/\//i.test(url)) return null;
      const tabId = str(r["tabId"]);
      const text = str(r["text"], MAX_TEXT);
      return {
        ...base,
        kind: "web",
        url: url.slice(0, 2000),
        ...(tabId ? { tabId } : {}),
        ...(text ? { text } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Parse a dev-build source stamp. Accepts `{file,line,column}` or the
 * `"path/to/File.tsx:12:5"` string form the build plugin writes.
 */
export function parseSourceLocation(raw: unknown): SourceLocation | undefined {
  if (typeof raw === "string") {
    const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw);
    if (!match || !match[1] || !match[2]) return undefined;
    const column = match[3] ? Number(match[3]) : undefined;
    return {
      file: match[1].slice(0, MAX_TEXT),
      line: Number(match[2]),
      ...(column !== undefined ? { column } : {}),
    };
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const file = str(r["file"], MAX_TEXT);
  const line = r["line"];
  if (
    !file ||
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 1
  ) {
    return undefined;
  }
  const column = r["column"];
  return {
    file,
    line,
    ...(typeof column === "number" && Number.isInteger(column)
      ? { column }
      : {}),
  };
}

/** The object kind whose noun names this target (one vocabulary door). */
const TARGET_NOUN_KIND: Record<PickTargetKind, string> = {
  entity: "entity",
  document: "document",
  cell: "cell",
  widget: "widget",
  view_row: "entity",
  shape: "shape",
  app_ui: "app",
  web: "website",
};

/** "Cell · Pipeline chart", "Document · Pricing", "Website · acme.com". */
export function describePickTarget(target: PickTarget): string {
  const noun =
    target.kind === "entity" && target.profileSlug
      ? resolveObjectNoun(target.profileSlug)
      : resolveObjectNoun(TARGET_NOUN_KIND[target.kind]);
  const detail =
    target.title ??
    (target.kind === "document" ? target.heading : undefined) ??
    (target.kind === "web" ? hostOf(target.url) : undefined);
  return detail ? `${noun} · ${detail}` : noun;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Flatten a target into string fields for an agent's turn context
 * (`target.kind`, `target.entityId`, `target.source`…). Identity only.
 */
export function pickTargetToContext(
  target: PickTarget
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(target)) {
    if (value === undefined) continue;
    if (key === "source" && typeof value === "object" && value) {
      const s = value as SourceLocation;
      out["source"] = `${s.file}:${s.line}${s.column ? `:${s.column}` : ""}`;
    } else if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}
