/**
 * Live structure progress — the ONE wire contract for the frames a capture
 * run's progress tail emits while `capture.structure` is working
 * (`GET /api/capture/runs/:captureRunId/progress`, SSE).
 *
 * Real stages and a live draft, never fake steps: a `stage` frame is sent only
 * on a real transition in pod/IS code, a `draft` frame is a full SNAPSHOT of
 * the settled entities (never a diff), and `done` closes the run.
 *
 * Dependency-free on purpose (no zod): relay decodes frames on Hermes per SSE
 * chunk. `decodeStructureProgressFrame` is the only reader — an unknown
 * version, kind, stage or outcome decodes to null and is ignored.
 */

export const STRUCTURE_STAGES = [
  "reading",
  "understanding",
  "placing",
  "matching",
  "asking",
] as const;
export type StructureStage = (typeof STRUCTURE_STAGES)[number];

export const STRUCTURE_OUTCOMES = [
  "plan",
  "follow_up",
  "empty",
  "degraded",
] as const;
export type StructureOutcome = (typeof STRUCTURE_OUTCOMES)[number];

export const STRUCTURE_PROGRESS_LIMITS = {
  /** Entities kept per draft snapshot; the rest are dropped. */
  draftEntitiesMax: 12,
  /** Draft entity titles are truncated to this many characters (code points). */
  titleMaxChars: 80,
  /**
   * Emitter-side throttle: at most this many draft frames per second, and only
   * when the settled set changed. Not enforceable by a per-frame decoder.
   */
  draftFramesPerSecondMax: 4,
} as const;

export interface StructureDraftEntity {
  title: string;
  profileSlug: string;
}

export type StructureProgressEvent =
  | {
      v: 1;
      seq: number;
      kind: "stage";
      stage: StructureStage;
      attempt: number;
      at: string;
    }
  | {
      v: 1;
      seq: number;
      kind: "draft";
      attempt: number;
      rev: number;
      entities: StructureDraftEntity[];
    }
  | {
      v: 1;
      seq: number;
      kind: "done";
      outcome: StructureOutcome;
    };

function isCount(value: unknown, min: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(
  values: ReadonlyArray<T>,
  value: unknown
): value is T {
  return (
    typeof value === "string" &&
    (values as ReadonlyArray<string>).includes(value)
  );
}

/** Truncate by code point so a cut never leaves half a surrogate pair. */
function truncateTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= STRUCTURE_PROGRESS_LIMITS.titleMaxChars
    ? title
    : chars.slice(0, STRUCTURE_PROGRESS_LIMITS.titleMaxChars).join("");
}

function decodeDraftEntities(raw: unknown): StructureDraftEntity[] | null {
  if (!Array.isArray(raw)) return null;
  const entities: StructureDraftEntity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { title, profileSlug } = item as Record<string, unknown>;
    // A snapshot with a malformed member is not a snapshot: drop the frame
    // rather than render a set the server never settled.
    if (!isNonEmptyString(title) || !isNonEmptyString(profileSlug)) return null;
    entities.push({ title: truncateTitle(title), profileSlug });
  }
  return entities.slice(0, STRUCTURE_PROGRESS_LIMITS.draftEntitiesMax);
}

/**
 * One SSE frame's parsed JSON → a contract event, or null when it is not a
 * v1 frame this client understands. Unknown fields are stripped; titles are
 * truncated and drafts capped (bounds are applied, not rejected).
 */
export function decodeStructureProgressFrame(
  input: unknown
): StructureProgressEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const frame = input as Record<string, unknown>;
  if (frame.v !== 1 || !isCount(frame.seq, 0)) return null;
  const seq = frame.seq;

  switch (frame.kind) {
    case "stage": {
      if (!isOneOf(STRUCTURE_STAGES, frame.stage)) return null;
      if (!isCount(frame.attempt, 1) || !isNonEmptyString(frame.at))
        return null;
      return {
        v: 1,
        seq,
        kind: "stage",
        stage: frame.stage,
        attempt: frame.attempt,
        at: frame.at,
      };
    }
    case "draft": {
      if (!isCount(frame.attempt, 1) || !isCount(frame.rev, 0)) return null;
      const entities = decodeDraftEntities(frame.entities);
      if (!entities) return null;
      return {
        v: 1,
        seq,
        kind: "draft",
        attempt: frame.attempt,
        rev: frame.rev,
        entities,
      };
    }
    case "done": {
      if (!isOneOf(STRUCTURE_OUTCOMES, frame.outcome)) return null;
      return { v: 1, seq, kind: "done", outcome: frame.outcome };
    }
    default:
      return null;
  }
}
