/**
 * @synap-core/types/presentation — how an entity PRESENTS itself.
 *
 * The ONE contract between the catalog (a kind declares its presentation on its
 * profile, stored as `profiles.uiHints.presentation`), the pod (validation,
 * backfill, the capture-copy job that fills `entities.systemData.media`) and
 * every renderer (web, relay). Plan: pod document ede89d4d (entity rendering
 * consolidation, approved 2026-10-13).
 *
 * Model (what the market converged on): ONE object, a small fixed set of
 * ALTITUDES chosen by the host; the kind's FAMILY chooses the anatomy; users
 * get per-view knobs only, never a per-object layout.
 *
 * LEAF subpath: no zod, no drizzle, no React. Relay node tests and the CLI
 * import leaf subpaths only.
 */

/** The five presentation families. The family picks the card anatomy. */
export const PRESENTATION_FAMILIES = [
  "media",
  "document",
  "link",
  "record",
  "work",
] as const;
export type PresentationFamily = (typeof PRESENTATION_FAMILIES)[number];

/**
 * The altitudes a host may ask for, smallest to largest. Canvas nodes, document
 * embeds and media tiles are NOT altitudes: they are the `card` altitude drawn
 * at the size the host gives it.
 */
export const ENTITY_ALTITUDES = ["chip", "row", "card", "peek", "page"] as const;
export type EntityAltitude = (typeof ENTITY_ALTITUDES)[number];

/** Density of the `card` altitude. */
export const CARD_DENSITIES = ["compact", "medium", "full"] as const;
export type CardDensity = (typeof CARD_DENSITIES)[number];

/** Field caps per altitude (Salesforce compact-layout discipline). */
export const PRESENTATION_FIELD_CAPS = { row: 2, card: 6 } as const;

/** Where a kind's primary media lives. Exactly one key. */
export type PresentationMediaSource =
  /** a property holding a stored-file reference or an external URL */
  | { property: string }
  /** the entity's own linked document (`entities.documentId`), e.g. `file` */
  | { documentId: true }
  /** a property holding the id of another entity (a `file`) whose media is used */
  | { entityRef: string };

export type PresentationMediaKind = "image" | "video" | "auto";

/** Declared on a profile (catalog YAML `presentation:`), stored as `uiHints.presentation`. */
export interface ProfilePresentation {
  family: PresentationFamily;
  media?: {
    source: PresentationMediaSource;
    /** `auto` (default) = decide from the mime type */
    kind?: PresentationMediaKind;
  };
  /** Optional property subsets per altitude; capped by PRESENTATION_FIELD_CAPS. */
  fields?: { card?: string[]; row?: string[] };
}

/**
 * One media item the pod copied into itself (decision D2: external images are
 * copied at capture, never hot-linked). Written by the pod's copy job to
 * `entities.systemData.media`; never user-editable.
 */
export interface EntityMediaCopy {
  documentId: string;
  mime: string;
  bytes: number;
  /** the external URL it was copied from */
  sourceUrl: string;
  width?: number;
  height?: number;
  copiedAt: string;
}

/**
 * What a renderer gets back for "this entity's media". A REFERENCE, never a
 * URL: signing is async and lives in the display door (`useStoredFileUrl` →
 * `SpatialMediaPreview`), which also decides renderability (mime allowlist).
 */
export type MediaRef =
  | {
      via: "stored";
      documentId?: string;
      entityId?: string;
      mime?: string;
      width?: number;
      height?: number;
    }
  /** an external URL not copied (yet): render as a link chip, never an <img> */
  | { via: "external"; url: string; kind: PresentationMediaKind }
  | { via: "none" };

export type PresentationIssue = { path: string; message: string };

/**
 * Pure parser for an untrusted `presentation` value (catalog validator, pod
 * apply, frontend normaliser — one rule set). Returns the normalised value, or
 * the issues. Unknown keys are dropped.
 */
export function parseProfilePresentation(
  value: unknown,
):
  | { ok: true; value: ProfilePresentation }
  | { ok: false; issues: PresentationIssue[] } {
  const issues: PresentationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: "presentation", message: "must be an object" }] };
  }
  const family = value.family;
  if (typeof family !== "string" || !(PRESENTATION_FAMILIES as readonly string[]).includes(family)) {
    issues.push({
      path: "presentation.family",
      message: `must be one of ${PRESENTATION_FAMILIES.join(", ")}`,
    });
  }
  const out: ProfilePresentation = { family: family as PresentationFamily };

  if (value.media !== undefined) {
    const media = value.media;
    if (!isRecord(media) || !isRecord(media.source)) {
      issues.push({ path: "presentation.media.source", message: "must be an object" });
    } else {
      const src = media.source;
      const keys = ["property", "documentId", "entityRef"].filter((k) => src[k] !== undefined);
      let source: PresentationMediaSource | undefined;
      if (keys.length !== 1) {
        issues.push({
          path: "presentation.media.source",
          message: "must have exactly one of property, documentId, entityRef",
        });
      } else if (keys[0] === "property" && nonEmpty(src.property)) {
        source = { property: src.property };
      } else if (keys[0] === "documentId" && src.documentId === true) {
        source = { documentId: true };
      } else if (keys[0] === "entityRef" && nonEmpty(src.entityRef)) {
        source = { entityRef: src.entityRef };
      } else {
        issues.push({
          path: `presentation.media.source.${keys[0]}`,
          message: keys[0] === "documentId" ? "must be true" : "must be a non-empty property slug",
        });
      }
      const kind = media.kind ?? "auto";
      if (kind !== "image" && kind !== "video" && kind !== "auto") {
        issues.push({ path: "presentation.media.kind", message: "must be image, video or auto" });
      }
      if (source) out.media = { source, kind: kind as PresentationMediaKind };
    }
  }

  if (value.fields !== undefined) {
    const fields = value.fields;
    if (!isRecord(fields)) {
      issues.push({ path: "presentation.fields", message: "must be an object" });
    } else {
      const outFields: { card?: string[]; row?: string[] } = {};
      for (const alt of ["card", "row"] as const) {
        const list = fields[alt];
        if (list === undefined) continue;
        if (!Array.isArray(list) || !list.every(nonEmpty)) {
          issues.push({ path: `presentation.fields.${alt}`, message: "must be a list of property slugs" });
          continue;
        }
        if (list.length > PRESENTATION_FIELD_CAPS[alt]) {
          issues.push({
            path: `presentation.fields.${alt}`,
            message: `at most ${PRESENTATION_FIELD_CAPS[alt]} fields`,
          });
          continue;
        }
        outFields[alt] = list as string[];
      }
      if (outFields.card || outFields.row) out.fields = outFields;
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

/** Read `systemData.media` defensively (written by the pod, but stored as jsonb). */
export function readEntityMediaCopies(systemData: unknown): EntityMediaCopy[] {
  if (!isRecord(systemData) || !Array.isArray(systemData.media)) return [];
  return systemData.media.filter(
    (m): m is EntityMediaCopy =>
      isRecord(m) && nonEmpty(m.documentId) && nonEmpty(m.mime) && nonEmpty(m.sourceUrl),
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
