/**
 * MOVED HERE from `relay-app/src/components/rule-compose/cron-recurrence.ts`
 * (2026-10-06) so every composer — and the pod's text→rule parse door — offers
 * and NAMES the same schedules. These labels are the cron humaniser: a
 * schedule reads as its recurrence's label, or not at all (see
 * `matchCronRecurrence`). The phone's caveat line ("the pod's clock, not your
 * phone's") stayed in relay — it is that surface's copy.
 *
 * cron-recurrence — the SHORT, CLOSED set of schedules this surface can offer,
 * and the only way a cron trigger is built here.
 *
 * ── Why a closed set and not a cron field ──────────────────────────────────
 * `isSendableTrigger` has returned `true` for `triggerType: 'cron'` since the
 * composer was written, and nothing could ever produce one: `optionToTrigger`
 * takes an `EventOption` and hardcodes the `'event'` arm. Advertised as
 * sendable, impossible to author.
 *
 * The obvious unlock — a text input for a cron expression — is the exact
 * control Home Assistant frontend#7463 names as the anti-pattern: a control
 * that cannot round-trip its own value. `parseCron` (the grammar's reverse
 * converter) understands `*`, a literal `H:M`, `1-5`, a comma list and a
 * day-of-month, and NOTHING else. A user who typed a step-and-range expression
 * (every 15 minutes, between 9 and 17, on weekdays) would
 * get a rule that runs correctly and re-opens in the editor reading "every day
 * at 09:00" — and Save would then write that back. So the authorable set is
 * the set that round-trips, and it is small enough to be a list.
 *
 * That is also the phone-native precedent: Apple Shortcuts offers a handful of
 * named recurrences, never an expression editor.
 *
 * ── Deliberately NOT offered ───────────────────────────────────────────────
 * • A time picker, a day picker, a day-of-month picker. `SentenceTrigger`
 *   carries `cronTime` / `cronDays` / `cronDayOfMonth` and they are real, so
 *   these are a later composition on top of this list — not a reason to
 *   withhold the list. Every entry below therefore pins 09:00.
 * • `CronFrequency`'s sixth member, `"custom"`. `buildCronExpression` has no
 *   `case "custom"`, so it falls through to `default` and compiles to the
 *   DAILY expression. An option labelled "custom" that silently means "every
 *   day" is the silent-mangle this file exists to prevent.
 * • A timezone control. Nothing on the pod
 *   reads the timezone the grammar stores, so a picker for it would be a
 *   control whose value has no consumer. Refusing a field is honest.
 *
 * ── Why the labels are local copy and not the vocabulary door ──────────────
 * `.claude/rules/vocabulary.md` forbids a local label map for a domain value,
 * and `CronFrequency` is a type-system value — so this is worth being explicit
 * about. These are NOT frequency labels: they are schedule SENTENCES ("Every
 * weekday at 09:00"), keyed on this surface's own closed recurrence ids, and
 * they carry a time that is not part of the frequency at all. That puts them
 * in the rule's own "empty-state copy and sentences" carve-out. A map from
 * `CronFrequency` → words would be the forbidden fork; there is none here, and
 * nothing below ever humanises a frequency token.
 */

import {
  buildCronExpression,
  parseCron,
  type SentenceTrigger,
} from "./sentence.js";

/** One offerable schedule. `trigger` is the value; `label` is what it reads as. */
export interface CronRecurrence {
  /** Stable id for routing and selection. This surface's own, not a wire value. */
  id: string;
  label: string;
  trigger: SentenceTrigger;
}

/** The hour every dated entry fires at. One constant, so the labels cannot drift. */
const AT = "09:00";

/**
 * The zone every dated label names, because the pod schedules in it.
 *
 * ⚠️ A BARE HOUR HERE WAS A LIE. `computeNextRunAt` matches with process-local
 * accessors, so a rule fires on the WORKER's clock; a reader in Paris seeing
 * "Every Monday at 09:00" got 11:00 in summer. Nothing errors, nothing looks
 * empty — the rule simply runs at an hour nobody chose, which is the worst
 * shape a defect can have on this surface.
 *
 * It is safe to state UTC only because the runner image now PINS it
 * (`synap-backend/deploy/Dockerfile`, `ENV TZ=UTC`). Before that it was UTC by
 * accident — `node:20-alpine` ships no `/etc/localtime` — and a label may not
 * assert something that is merely likely.
 *
 * ⚠️ This is a HONEST LABEL, not the fix. The fix is per-author zones:
 * `toBackendTrigger` already stores `timezone: cronTimezone ?? "UTC"` and
 * NOTHING reads it back — a stamp nobody earned. When `computeNextRunAt` reads
 * it and relay defaults it to the device zone, these labels can drop the suffix
 * and say the user's own time. Until then, naming the zone is the only
 * statement that is true for every reader.
 */
const ZONE = "UTC";

/**
 * The offerable schedules, in the order they are shown.
 *
 * Each `trigger` is a plain `SentenceTrigger`; the expression is DERIVED from
 * it by the grammar's own `buildCronExpression` at compile time (through
 * `toBackendTrigger` inside `sentenceToWriteInput`), never hand-written here.
 * That is what keeps the `expression`-vs-`cron` key trap handled at the one
 * place that already handles it: a `triggerConfig` written by hand would carry
 * only whichever key its author remembered, and a flow with only `.cron` gets
 * `nextRunAt: null` and never fires.
 */
export const CRON_RECURRENCES: readonly CronRecurrence[] = [
  {
    id: "hourly",
    label: "Every hour",
    trigger: { triggerType: "cron", cronFrequency: "hourly" },
  },
  {
    id: "daily",
    label: `Every day at ${AT} ${ZONE}`,
    trigger: { triggerType: "cron", cronFrequency: "daily", cronTime: AT },
  },
  {
    id: "weekdays",
    label: `Every weekday at ${AT} ${ZONE}`,
    trigger: { triggerType: "cron", cronFrequency: "weekdays", cronTime: AT },
  },
  {
    id: "monday",
    label: `Every Monday at ${AT} ${ZONE}`,
    trigger: {
      triggerType: "cron",
      cronFrequency: "weekly",
      cronTime: AT,
      cronDays: [1],
    },
  },
  {
    id: "monthly",
    label: `On the 1st of the month, at ${AT} ${ZONE}`,
    trigger: {
      triggerType: "cron",
      cronFrequency: "monthly",
      cronTime: AT,
      cronDayOfMonth: 1,
    },
  },
];

/**
 * The expression a recurrence compiles to — the grammar's own builder, so this
 * module never spells a cron string.
 */
export function cronExpressionOf(trigger: SentenceTrigger): string {
  return buildCronExpression(trigger);
}

/**
 * The recurrence a (possibly stored, possibly re-parsed) cron trigger came
 * from, matched on the COMPILED EXPRESSION rather than on the decomposed
 * fields.
 *
 * Same technique, and the same reason, as `matchEventOptionPattern` for
 * events: the decomposition a stored rule loads back through `parseCron` is
 * not field-identical to the one that was authored (`parseCron` returns no
 * `cronDays` for `weekdays`, and no `cronTime` at all for `hourly`), so a
 * field-by-field compare would lose the tick on a rule the user had just
 * saved. Both sides go through the one builder, so equal schedules match.
 */
export function matchCronRecurrence(
  trigger: SentenceTrigger | null | undefined
): CronRecurrence | undefined {
  if (!trigger || trigger.triggerType !== "cron") return undefined;
  const expr = cronExpressionOf(trigger);
  return CRON_RECURRENCES.find((r) => cronExpressionOf(r.trigger) === expr);
}

/** A recurrence by id. */
export function cronRecurrence(id: string): CronRecurrence | undefined {
  return CRON_RECURRENCES.find((r) => r.id === id);
}

// ── Any stored cron, read back as words ─────────────────────────────────────
//
// MOVED HERE from `browser/…/apps/rules/rule-words.ts` (2026-10-06). The
// closed list above labels what the composers OFFER; a stored rule may carry
// any expression the grammar round-trips (an agent wrote it, or a template),
// and the Rules page must still say it in the same phrasing. For every offered
// recurrence the two agree — pinned in `cron-recurrence.test.ts`.

const NUM = /^\d{1,2}$/;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function weekdayName(day: number): string {
  // 2023-01-01 was a Sunday, so day 0..6 maps onto that week.
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2023, 0, 1 + (day % 7))));
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * A cron expression as words, in the phrasing of {@link CRON_RECURRENCES}
 * ("Every day at 09:00 UTC", "Every Monday at 09:00 UTC", "On the 1st of the
 * month, at 09:00 UTC"). Only the shapes `parseCron` round-trips are phrased —
 * a step, range or list it would misread (`*\/15`) returns null, never a
 * confident wrong sentence.
 */
export function cronWords(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!NUM.test(m) || mon !== "*") return null;
  if (!(h === "*" || NUM.test(h))) return null;
  if (!(dom === "*" || NUM.test(dom))) return null;
  if (!(dow === "*" || dow === "1-5" || /^\d(,\d)*$/.test(dow))) return null;
  if (h === "*") return dom === "*" && dow === "*" ? "Every hour" : null;

  const parsed = parseCron(expression.trim());
  const at = `at ${parsed.cronTime} ${ZONE}`;
  switch (parsed.cronFrequency) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Every weekday ${at}`;
    case "weekly":
      return `Every ${joinWords((parsed.cronDays ?? []).map(weekdayName))} ${at}`;
    case "monthly":
      return parsed.cronDayOfMonth
        ? `On the ${ordinal(parsed.cronDayOfMonth)} of the month, ${at}`
        : null;
    default:
      return null;
  }
}
