/**
 * THE HOME BRIEF — the one sentence at the top of Home that says where things
 * stand (skill `lens-page`, "The Home exception", founder pick 2026-10-19
 * "brief first"):
 *
 *   "While you were away your agents finished 8 things. 3 decisions are
 *    holding up 2 projects. 1 run failed. 2 agents are working now."
 *
 * ONE pure derivation shared by the desktop and relay, fed by the SAME counts
 * the rail badge and the Inbox use (ui-composition §11 — the needs-you
 * buckets, `needsYouBuckets`; never a second classifier). Every noun phrase
 * is a DOOR (`HomeBriefDoor`); the host routes it.
 *
 * Rules, each a test:
 *   - a clause whose count is ZERO is dropped — never "0 decisions";
 *   - a count that is UNKNOWN (a failed read, `null`) is dropped too, but the
 *     brief says so (`unknown`): a partly failed brief is not a calm one;
 *   - every count known and zero ⇒ REASSURE ("All clear");
 *   - a capped count reads "N+" (its `floor`), and is plural;
 *   - "holding up N projects" only when the project count is known and > 0 —
 *     otherwise the waiting clause says "wait on you", never a guessed link.
 */
import type { NeedsYouBucket } from "../needs-you/buckets.js";
import { formatFloorCount } from "./header.js";

/** One count the brief reads. `count: null` = the read failed (unknown ≠ 0). */
export interface HomeBriefCount {
  count: number | null;
  /** `count` is a lower bound (a capped read) — it reads "N+". */
  floor?: boolean;
}

export interface HomeBriefInput {
  /**
   * The window "finished" is counted over: since the person was last seen
   * (`last-seen`), or — with no last visit on record — today.
   */
  since: "last-seen" | "today";
  /** Things the agents finished in the window (`outputs.landed`, actor agents). */
  produced: HomeBriefCount;
  /** The Inbox's `decision` bucket. */
  decisions: HomeBriefCount;
  /** The Inbox's `question` bucket. */
  questions: HomeBriefCount;
  /** Active projects with something waiting on the person. */
  projectsHeldUp: HomeBriefCount;
  /** The Inbox's `broken` bucket — failed work only (health is the banner). */
  failed: HomeBriefCount;
  /** Agents working right now (live work lines). */
  working: HomeBriefCount;
}

/** Where a noun phrase of the brief opens. The host maps it to its route table. */
export type HomeBriefDoor =
  | { kind: "produced" }
  | { kind: "inbox"; bucket: NeedsYouBucket | null }
  | { kind: "projects" }
  | { kind: "moving" };

/** A run of the sentence: plain words, or a door. */
export interface HomeBriefSegment {
  text: string;
  door?: HomeBriefDoor;
}

export type HomeBriefClauseKey = "produced" | "waiting" | "failed" | "working";

export interface HomeBriefClause {
  key: HomeBriefClauseKey;
  /** The clause as one sentence, ending in a full stop. */
  segments: HomeBriefSegment[];
}

export interface HomeBrief {
  /**
   * `brief` — at least one clause; `reassure` — every count known and zero;
   * `unknown` — nothing to say and at least one count unread (never calm).
   */
  answer: "brief" | "reassure" | "unknown";
  clauses: HomeBriefClause[];
  /** At least one count was unread: the host marks the brief as partial. */
  unknown: boolean;
  /** The REASSURE words (only when `answer` is `reassure`). */
  reassure: string | null;
}

/** The REASSURE sentence — empty is the good outcome. */
export const HOME_BRIEF_ALL_CLEAR = "All clear — nothing waits on you.";

const known = (c: HomeBriefCount): c is { count: number; floor?: boolean } =>
  typeof c.count === "number" && Number.isFinite(c.count);
const positive = (c: HomeBriefCount): c is { count: number; floor?: boolean } =>
  known(c) && c.count > 0;

/** "3", "100+" — the one floor formatter (`formatFloorCount`). */
function num(c: { count: number; floor?: boolean }): string {
  return formatFloorCount(c.count, c.floor === true);
}

/** Singular only for an exact 1 — "1+ things" is a floor, so plural. */
function isOne(c: { count: number; floor?: boolean }): boolean {
  return c.count === 1 && !c.floor;
}

function counted(
  c: { count: number; floor?: boolean },
  singular: string,
  plural: string
): string {
  return `${num(c)} ${isOne(c) ? singular : plural}`;
}

export function homeBrief(input: HomeBriefInput): HomeBrief {
  const clauses: HomeBriefClause[] = [];

  if (positive(input.produced)) {
    clauses.push({
      key: "produced",
      segments: [
        {
          text:
            input.since === "last-seen"
              ? "While you were away your agents "
              : "Today your agents ",
        },
        {
          text: `finished ${counted(input.produced, "thing", "things")}`,
          door: { kind: "produced" },
        },
        { text: "." },
      ],
    });
  }

  const waiting: HomeBriefSegment[] = [];
  if (positive(input.decisions)) {
    waiting.push({
      text: counted(input.decisions, "decision", "decisions"),
      door: { kind: "inbox", bucket: "decision" },
    });
  }
  if (positive(input.questions)) {
    if (waiting.length > 0) waiting.push({ text: " and " });
    waiting.push({
      text: counted(input.questions, "question", "questions"),
      door: { kind: "inbox", bucket: "question" },
    });
  }
  if (waiting.length > 0) {
    // One waiting thing in total, exactly ⇒ singular verb.
    const decisionsN = positive(input.decisions) ? input.decisions : null;
    const questionsN = positive(input.questions) ? input.questions : null;
    const single =
      (decisionsN ? 1 : 0) + (questionsN ? 1 : 0) === 1 &&
      isOne((decisionsN ?? questionsN)!);
    if (positive(input.projectsHeldUp)) {
      waiting.push(
        { text: single ? " is holding up " : " are holding up " },
        {
          text: counted(input.projectsHeldUp, "project", "projects"),
          door: { kind: "projects" },
        },
        { text: "." }
      );
    } else {
      waiting.push({ text: single ? " waits on you." : " wait on you." });
    }
    clauses.push({ key: "waiting", segments: waiting });
  }

  if (positive(input.failed)) {
    clauses.push({
      key: "failed",
      segments: [
        {
          text: `${counted(input.failed, "run", "runs")} failed`,
          door: { kind: "inbox", bucket: "broken" },
        },
        { text: "." },
      ],
    });
  }

  if (positive(input.working)) {
    clauses.push({
      key: "working",
      segments: [
        {
          text: isOne(input.working)
            ? "1 agent is working now"
            : `${num(input.working)} agents are working now`,
          door: { kind: "moving" },
        },
        { text: "." },
      ],
    });
  }

  const counts = [
    input.produced,
    input.decisions,
    input.questions,
    input.failed,
    input.working,
  ];
  // The project count only qualifies the waiting clause; on its own it
  // neither makes the brief partial nor blocks the all-clear.
  const unknown = counts.some((c) => !known(c));
  const answer: HomeBrief["answer"] =
    clauses.length > 0 ? "brief" : unknown ? "unknown" : "reassure";
  return {
    answer,
    clauses,
    unknown,
    reassure: answer === "reassure" ? HOME_BRIEF_ALL_CLEAR : null,
  };
}

/** The brief as plain text (an accessible summary, a test, relay's first cut). */
export function homeBriefText(brief: HomeBrief): string {
  if (brief.answer === "reassure") return brief.reassure ?? "";
  return brief.clauses
    .map((c) => c.segments.map((s) => s.text).join(""))
    .join(" ");
}
