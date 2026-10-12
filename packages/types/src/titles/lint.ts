/**
 * The title rubric — ONE derivation of "is this a good title?", platform-wide.
 *
 * Source: the "Knowledge and title quality" plan (pod doc 9992207a, section 3,
 * "Title rubric"). The same rubric scores three things that must agree: the
 * write-receipt lint a writer gets back, the pod re-audit, and the IS structure
 * eval. A per-surface copy is a fork the moment it exists.
 *
 * A title is a short NAME for a lasting thing. The rubric never rewrites a
 * title and never clips one — it only says what is wrong, so the writer can
 * rewrite it. Pure; no imports.
 */

/** Aim for 40–70; past this a title is too long to scan. */
export const TITLE_SOFT_MAX = 80;
/** A real question needs more room than a name. */
export const QUESTION_TITLE_SOFT_MAX = 110;
/**
 * Hard bound at the write doors: longer is REFUSED, never stored and never
 * clipped. Same value as `SESSION_TITLE_MAX`.
 */
export const TITLE_HARD_MAX = 200;

export type TitleLintCode =
  | "empty"
  | "truncated"
  | "too_long"
  | "status_word"
  | "shouting"
  | "emoji"
  | "machinery"
  | "speech"
  | "too_short"
  | "placeholder"
  | "plan_code"
  // Counted, not a defect on its own:
  | "date_stamp"
  | "kind_prefix";

export interface TitleLintIssue {
  code: TitleLintCode;
  /** `defect` fails the rubric; `note` is counted but passes on its own. */
  severity: "defect" | "note";
  /** What to do instead, addressed to the writer. */
  message: string;
}

export interface LintTitleOptions {
  /** Profile slug of the thing being titled (`question`, `note`, `task`…). */
  kind?: string | null;
  /**
   * The longer text the title may have been taken from (a knowledge claim, a
   * goal, a transcript). A title that is a cut-off start of it is `truncated`
   * even without an ellipsis — the 120-character cut left none.
   */
  source?: string | null;
}

/** Kinds whose title may not be one or two words (a bare label says nothing). */
const NEEDS_THREE_WORDS = new Set(["note", "item", "task", "session"]);

const STATUS_WORDS =
  /\b(SHIPPED|LIVE|FIXED|DONE|VERIFIED|CORRECTION|DEPLOYED|MERGED|RESOLVED|WIP)\b/;
/** Past-tense progress words: they describe an event, not a lasting thing. */
const STATUS_PHRASES = /\b(shipped|verified|deployed)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const PLACEHOLDER =
  /^(untitled(\s+\w+)?|test|testing|todo|tbd|placeholder|no title|new (note|entity|task|item|session))$/i;
const SPEECH =
  /^(okay|ok|i|could you|can you|would you|please|now let's|let's)\b/i;
const URL_LIKE = /\bhttps?:\/\/|\bwww\.\w/i;
const KIND_PREFIX =
  /^(lesson|decision|caution|gotcha|finding|insight|fact|note|idea|gap|bug|issue|question|task|knowledge)\s*[:—–-]\s/i;
const PLAN_CODE =
  /^((?:[A-Z]{1,3}\d{1,2}[a-z]?)|(?:(?:Wave|Lane|Move|Dive|Gate|Session)\s+[A-Z0-9]{1,3}))(?=$|[\s:—–,.-])/;
/** Technical names shaped like a plan code that a reader does know. */
const NOT_PLAN_CODES = new Set([
  "S3",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "E2E",
  "K8S",
  "MP3",
  "MP4",
  "B2B",
  "B2C",
  "W3C",
  "U2F",
  "I18N",
  "L10N",
  "A11Y",
  "OS2",
]);
const DATE_STAMP =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/** Each machinery pattern, with the words a writer recognises it by. */
const MACHINERY: ReadonlyArray<readonly [RegExp, string]> = [
  [/`/, "backticks"],
  [/\*\*/, "markdown bold"],
  [/\[\[/, "a wiki link"],
  [URL_LIKE, "a URL"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/i, "a hash or id"],
  [
    /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|sql|ya?ml|py|css|html|sh|toml)\b/i,
    "a file name",
  ],
  [/\w\.\w+:\d+\b/, "a line number"],
];

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function words(value: string): string[] {
  return value.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/**
 * Run the rubric. Returns every issue found, one per code, in rubric order.
 * An empty array means the title is clean. Never throws.
 */
export function lintTitle(
  title: string | null | undefined,
  options: LintTitleOptions = {}
): TitleLintIssue[] {
  const kind = options.kind?.trim().toLowerCase() || null;
  const text = typeof title === "string" ? oneLine(title) : "";
  const issues: TitleLintIssue[] = [];
  const defect = (code: TitleLintCode, message: string) =>
    issues.push({ code, severity: "defect", message });
  const note = (code: TitleLintCode, message: string) =>
    issues.push({ code, severity: "note", message });

  if (!text) {
    defect("empty", "The title is empty. Name the thing in a short phrase.");
    return issues;
  }

  const source =
    typeof options.source === "string" ? oneLine(options.source) : "";
  const stem = text.replace(/(…|\.\.\.)$/, "").trimEnd();
  const cutFromSource =
    source.length > stem.length &&
    stem.length >= 20 &&
    source.startsWith(stem) &&
    !/[.!?:;)]$/.test(stem) &&
    // Cut mid-word, or so long that only a length limit explains where it
    // stops. A short title that happens to start the claim is a fine handle.
    (/[\p{L}\p{N}]/u.test(source[stem.length] ?? "") ||
      stem.length > TITLE_SOFT_MAX);
  if (/(…|\.\.\.)$/.test(text) || cutFromSource) {
    defect(
      "truncated",
      "The title reads as cut off. Rewrite it as one complete phrase; never shorten by cutting."
    );
  }

  const softMax =
    kind === "question" ? QUESTION_TITLE_SOFT_MAX : TITLE_SOFT_MAX;
  if (text.length > softMax) {
    defect(
      "too_long",
      `The title is ${text.length} characters; keep it to ${softMax} at most (aim for 40–70). Rewrite it shorter and put the detail in the body or claim.`
    );
  }

  const status = text.match(STATUS_WORDS) ?? text.match(STATUS_PHRASES);
  if (status) {
    defect(
      "status_word",
      `"${status[0]}" is a status, not a name. Name the lasting thing; status goes in a status property.`
    );
  }

  const shouted = words(text).filter((w) => {
    const letters = w.replace(/[^\p{L}]/gu, "");
    return (
      letters.length >= 2 &&
      letters === letters.toUpperCase() &&
      letters !== letters.toLowerCase()
    );
  });
  if (shouted.length >= 3) {
    defect(
      "shouting",
      `The title has ${shouted.length} all-caps words. Use plain words; keep only glossary codes in capitals.`
    );
  }

  if (EMOJI.test(text)) {
    defect("emoji", "Remove the emoji from the title.");
  }

  const machinery = MACHINERY.filter(([re]) => re.test(text)).map(
    ([, label]) => label
  );
  if (machinery.length) {
    defect(
      "machinery",
      `The title contains ${machinery.join(", ")}. Move it to the body as evidence.`
    );
  }

  if (SPEECH.test(text) && !/^i\//i.test(text)) {
    defect(
      "speech",
      "The title starts like speech. Name the thing instead of quoting what was said."
    );
  }

  if (PLACEHOLDER.test(text)) {
    defect("placeholder", `"${text}" is a placeholder. Name the thing.`);
  } else if (kind && NEEDS_THREE_WORDS.has(kind) && words(text).length <= 2) {
    defect(
      "too_short",
      `A ${kind} titled in ${words(text).length === 1 ? "one word" : "two words"} says too little. Use a short phrase.`
    );
  }

  const code = text.match(PLAN_CODE);
  if (code && !NOT_PLAN_CODES.has(code[1].toUpperCase())) {
    defect(
      "plan_code",
      `The title starts with the plan code "${code[1]}". Replace it with words a reader knows.`
    );
  }

  if (DATE_STAMP.test(text)) {
    note(
      "date_stamp",
      "The title carries a date. The date is already on the record; drop it unless it names a period."
    );
  }

  const prefix = text.match(KIND_PREFIX);
  if (prefix) {
    note(
      "kind_prefix",
      `The title repeats its kind ("${prefix[1]}"). The kind is already on the record.`
    );
  }

  return issues;
}

/** True when the rubric finds no defect (notes are allowed). */
export function isCleanTitle(
  title: string | null | undefined,
  options: LintTitleOptions = {}
): boolean {
  return !lintTitle(title, options).some((i) => i.severity === "defect");
}

/**
 * The refusal a write door returns for a title over {@link TITLE_HARD_MAX}.
 * Without a length it is the static form a schema validator can carry.
 */
export function titleTooLongReason(length?: number): string {
  const size =
    length === undefined
      ? "title is too long"
      : `title is ${length} characters`;
  return `${size}; the limit is ${TITLE_HARD_MAX} (aim for ${TITLE_SOFT_MAX} or less). A title is a short name. Put the full text in the body or the claim.`;
}
