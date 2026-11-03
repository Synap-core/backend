/**
 * THE PROPS OF A WORK BLOCK, AS EVERY CLIENT READS THEM — `lens-section` and
 * `status-mark` (catalog `WIDGET_DEFINITIONS`, `renderables/widgets.ts`).
 *
 * Before this module each client read them its own way (Generative UI wave 3,
 * plan 9ad4b2fc §3): the web (`pageSectionConfig`) fell back silently on a bad
 * `empty`, the phone (`readWorkCell`) marked the block broken; the phone
 * trimmed the section, the web did not; a page-only section was "unknown" on
 * the phone and a door to its page on the web. Founder decision Q1 (3 Nov
 * 2026, as recommended): a bad prop is BROKEN for the author, with the
 * reason, and a QUIET FALLBACK for the reader.
 *
 *   mode "author"  the editor, a refresher, the document's diagnostics: the
 *                  first prop that cannot be read is the answer, with why.
 *   mode "reader"  a document's reader: an optional prop that cannot be read
 *                  (`empty`, `limit`) falls back to the section's own answer
 *                  and is listed in `fellBack`; a section that names nothing
 *                  drawable is still not drawn (nothing can be invented in its
 *                  place), and the client shows its one quiet mark.
 *
 * Shared by both modes, as both clients did: `limit` is clamped to the
 * catalog's 1-10, never broken; `null` and absent mean the same (unset).
 * Pure: the lens tables only.
 */

import { isUuid } from "../property-render/structured-value.js";
import type { StatusOfAnswerType } from "../units/status-of.js";
import {
  ATTENTION_CLASSES,
  LENS_CAPS,
  LENS_SECTION_LIMIT_MAX,
  LENS_SECTION_LIMIT_MIN,
  LENS_SECTION_ORDER,
  lensSectionDefaultEmpty,
  readLensSectionEmpty,
  type AttentionClass,
  type LensSection,
  type LensSectionEmptyAnswer,
} from "./sections.js";

/** The catalog's bounds of a `lens-section`'s `limit`, held with the section tables. */
export { LENS_SECTION_LIMIT_MAX, LENS_SECTION_LIMIT_MIN };

/** Who reads the props: the author sees every problem, the reader a quiet fallback. */
export type LensBlockReadMode = "author" | "reader";

/** Why a `lens-section`'s props cannot be drawn as written. Its words are each client's. */
export type LensSectionBlockProblem =
  /** No `section`, a blank one, or one that is not a string. */
  | { why: "no-section" }
  /** A `section` the lens page does not have. */
  | { why: "unknown-section"; section: string }
  /** A section of the PAGE (Done when, Who's on it, Plan, Data): it has its own read, on its own page. */
  | { why: "page-only"; section: Exclude<LensSection, AttentionClass> }
  /** An `empty` that is none of `LENS_SECTION_EMPTY_ANSWERS` (a legacy `invite` reads as `explain`). */
  | { why: "bad-empty"; value: unknown }
  /** A `limit` that is not a finite number. */
  | { why: "bad-limit"; value: unknown };

/** What a drawable `lens-section` block says. */
export interface LensSectionBlock {
  section: AttentionClass;
  /** Rows at rest before "Show all": the author's, clamped, else the class's own (`LENS_CAPS`). */
  limit: number;
  /** The empty answer: the author's, else the section's own (`lensSectionDefaultEmpty`). */
  empty: LensSectionEmptyAnswer;
}

export type LensSectionBlockRead =
  | (LensSectionBlock & {
      ok: true;
      /** Reader mode only: the optional props that fell back, for diagnostics. Empty in author mode. */
      fellBack: LensSectionBlockProblem[];
    })
  | { ok: false; problem: LensSectionBlockProblem };

const PAGE_ONLY = LENS_SECTION_ORDER.filter(
  (s) => !(ATTENTION_CLASSES as readonly string[]).includes(s)
) as Exclude<LensSection, AttentionClass>[];

function unset(v: unknown): boolean {
  return v === undefined || v === null;
}

/**
 * A `lens-section` block's props, read for `mode`. Never throws; a prop it
 * cannot read is a problem with its reason, never a silent default in author
 * mode, never a broken block in reader mode when a default exists.
 */
export function readLensSectionBlock(
  props: Record<string, unknown> | null | undefined,
  mode: LensBlockReadMode
): LensSectionBlockRead {
  const p = props ?? {};
  const raw = typeof p.section === "string" ? p.section.trim() : "";
  if (!raw) return { ok: false, problem: { why: "no-section" } };
  if (!(ATTENTION_CLASSES as readonly string[]).includes(raw)) {
    const pageOnly = (PAGE_ONLY as readonly string[]).includes(raw);
    return {
      ok: false,
      problem: pageOnly
        ? {
            why: "page-only",
            section: raw as Exclude<LensSection, AttentionClass>,
          }
        : { why: "unknown-section", section: raw },
    };
  }
  const section = raw as AttentionClass;
  const fellBack: LensSectionBlockProblem[] = [];

  let empty = lensSectionDefaultEmpty(section);
  if (!unset(p.empty)) {
    const read = readLensSectionEmpty(
      typeof p.empty === "string" ? p.empty.trim() : p.empty
    );
    if (read) empty = read;
    else {
      const problem: LensSectionBlockProblem = {
        why: "bad-empty",
        value: p.empty,
      };
      if (mode === "author") return { ok: false, problem };
      fellBack.push(problem);
    }
  }

  let limit: number = LENS_CAPS[section];
  if (!unset(p.limit)) {
    if (typeof p.limit === "number" && Number.isFinite(p.limit)) {
      limit = Math.min(
        LENS_SECTION_LIMIT_MAX,
        Math.max(LENS_SECTION_LIMIT_MIN, Math.floor(p.limit))
      );
    } else {
      const problem: LensSectionBlockProblem = {
        why: "bad-limit",
        value: p.limit,
      };
      if (mode === "author") return { ok: false, problem };
      fellBack.push(problem);
    }
  }

  return { ok: true, section, limit, empty, fellBack };
}

/**
 * The route kind of a `statusOf` answer's type, for the host's ONE route
 * table: a goal is a `track` there. Typed by the answer's own vocabulary
 * (`STATUS_OF_ANSWER_TYPES`), so a new answer type without its route fails
 * the build.
 */
export const STATUS_OF_ROUTE_KIND = {
  entity: "entity",
  goal: "track",
  session: "session",
  run: "run",
} as const satisfies Record<StatusOfAnswerType, string>;

/** A `status-mark` block's `id` prop: a trimmed UUID, else null (nothing to ask about). */
export function readStatusMarkId(
  props: Record<string, unknown> | null | undefined
): string | null {
  const id = props?.id;
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return isUuid(trimmed) ? trimmed : null;
}
