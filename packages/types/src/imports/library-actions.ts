/**
 * Library action chips — the DETERMINISTIC detectors behind
 * `LibraryItemRead.suggestedActions`, and the chip words every client shows.
 *
 * The light read runs these on what it read (title, card, body text). They
 * find four things a person may want to act on: a date (→ calendar), a receipt
 * (→ a note with amount + merchant), a contact (→ a person), a to-do line
 * (→ a task). A chip only SUGGESTS: running it files ONE governed proposal.
 *
 * Rules first, AI second: when the read already used AI, its suggestions are
 * normalised by {@link normalizeLibraryActions} and merged AFTER the rule
 * hits by {@link mergeLibraryActions} (a rule hit wins a tie).
 *
 * Ids are derived from the chip's value (`date-k3x9`), so a re-read keeps the
 * same id for the same chip and a chip already run keeps its `proposalId`.
 *
 * Pure and dependency-free: safe in the pod, the browser, relay and the CLI.
 */

import type { LibraryAction, LibraryActionKind } from "./library.js";

export interface LibraryActionInput {
  title?: string;
  /** Body text the light read got (page text, OCR, transcript, typed text). */
  text?: string;
  /** Site name or host — a merchant hint for receipts. */
  siteName?: string;
  /** "Today" for date detection (tests pass a fixed one). */
  now?: Date;
}

/** Caps and floors shared by the detectors and the AI normaliser. */
export const LIBRARY_ACTION_LIMITS = {
  perKind: { date: 2, receipt: 1, contact: 2, task: 3 } as Record<
    LibraryActionKind,
    number
  >,
  total: 6,
  /** Below this a chip is not shown. */
  minConfidence: 0.5,
  /** Characters scanned (a long page is not scanned whole). */
  textMax: 20_000,
  taskTitleMax: 80,
  eventTitleMax: 80,
  /** A date further ahead than this is not a calendar chip. */
  dateHorizonDays: 3 * 366,
} as const;

// ── Words ──────────────────────────────────────────────────────────────────

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatDay(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${d} ${MONTH_ABBR[(m ?? 1) - 1]}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function formatAmount(amount: unknown, currency: unknown): string | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  const fixed = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return str(currency) ? `${fixed} ${String(currency)}` : fixed;
}

/**
 * The chip's words, from its kind and value. Every client uses this so the
 * pod, the browser and relay say the same thing.
 */
export function libraryActionLabel(
  kind: LibraryActionKind,
  value: Record<string, unknown>
): string {
  switch (kind) {
    case "date": {
      const date = str(value.date);
      return date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? `Add ${formatDay(date)} to calendar`
        : "Add to calendar";
    }
    case "receipt": {
      const parts = [
        formatAmount(value.amount, value.currency),
        str(value.merchant),
      ].filter(Boolean);
      return parts.length
        ? `Keep receipt · ${parts.join(" · ")}`
        : "Keep receipt";
    }
    case "contact": {
      const who = str(value.name) ?? str(value.email) ?? str(value.phone);
      return who ? `Save contact · ${who}` : "Save contact";
    }
    case "task": {
      const title = str(value.title);
      return title ? `Add task · ${title}` : "Add task";
    }
  }
}

// ── Ids ────────────────────────────────────────────────────────────────────

/** FNV-1a, base36 — a short stable id suffix, not a security hash. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** What makes two chips "the same chip" (a re-read, or a rule and the AI agreeing). */
export function libraryActionKey(
  kind: LibraryActionKind,
  value: Record<string, unknown>
): string {
  const lower = (v: unknown) => (str(v) ?? "").toLowerCase();
  switch (kind) {
    case "date":
      return `date:${lower(value.date)}`;
    case "receipt":
      return `receipt:${typeof value.amount === "number" ? value.amount.toFixed(2) : ""}:${lower(value.currency)}`;
    case "contact":
      return `contact:${lower(value.email) || (str(value.phone) ?? "").replace(/\D/g, "")}`;
    case "task":
      return `task:${lower(value.title).replace(/\s+/g, " ")}`;
  }
}

function makeAction(
  kind: LibraryActionKind,
  value: Record<string, unknown>,
  confidence: number,
  source: "rule" | "ai"
): LibraryAction {
  return {
    id: `${kind}-${shortHash(libraryActionKey(kind, value))}`,
    kind,
    label: libraryActionLabel(kind, value),
    value,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
    source,
  };
}

// ── Sentences ──────────────────────────────────────────────────────────────

/** The sentence (or line) around `index`. */
function sentenceAt(text: string, index: number): string {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1]!)) start--;
  let end = index;
  while (end < text.length && !/[.!?\n]/.test(text[end]!)) end++;
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function clipWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

// ── Dates ──────────────────────────────────────────────────────────────────

/** English and French month words → month number. */
const MONTH_WORDS: ReadonlyArray<[RegExp, number]> = [
  [/^(jan|january|janv|janvier)$/, 1],
  [/^(feb|february|fev|fév|fevr|févr|fevrier|février)$/, 2],
  [/^(mar|march|mars)$/, 3],
  [/^(apr|april|avr|avril)$/, 4],
  [/^(may|mai)$/, 5],
  [/^(jun|june|juin)$/, 6],
  [/^(jul|july|juil|juillet)$/, 7],
  [/^(aug|august|aout|août)$/, 8],
  [/^(sep|sept|september|septembre)$/, 9],
  [/^(oct|october|octobre)$/, 10],
  [/^(nov|november|novembre)$/, 11],
  [/^(dec|december|déc|decembre|décembre)$/, 12],
];
const MONTH_RE =
  "jan(?:uary|v(?:ier)?)?|f[eé]v(?:r(?:ier)?)?|feb(?:ruary)?|mar(?:ch|s)?|apr(?:il)?|avr(?:il)?|may|mai|jun[e]?|juin|jul[y]?|juil(?:let)?|aug(?:ust)?|ao[uû]t|sep(?:t(?:ember|embre)?)?|oct(?:ober|obre)?|nov(?:ember|embre)?|d[eé]c(?:ember|embre)?";

function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  for (const [re, n] of MONTH_WORDS) if (re.test(w)) return n;
  return null;
}

/** Words that make a date an appointment rather than a mention. */
const EVENT_WORDS =
  /\b(meeting|meet|appointment|call|interview|event|webinar|conference|concert|flight|departure|arrival|check-?in|reservation|booking|booked|deadline|due|rsvp|invitation|invite|party|dinner|lunch|session|class|workshop|rendez-vous|rdv|réunion|reunion|vol|réservation|échéance|soirée|dîner|déjeuner)\b/i;

interface DateHit {
  index: number;
  date: string;
  time?: string;
  explicitYear: boolean;
}

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

/** "15:00", "3pm", "3:30 pm", "15h", "15h30" right after a date. */
function timeAfter(text: string, from: number): string | undefined {
  const tail = text.slice(from, from + 24);
  const m =
    /^[\s,]*(?:at|à|@|-|from|de)?\s*(\d{1,2})(?:(?::|h)(\d{2}))?\s*(am|pm|h)?\b/i.exec(
      tail
    );
  if (!m) return undefined;
  const hasMinutes = m[2] !== undefined;
  const marker = m[3]?.toLowerCase();
  if (!hasMinutes && !marker) return undefined;
  let hour = Number(m[1]);
  const minute = hasMinutes ? Number(m[2]) : 0;
  if (marker === "pm" && hour < 12) hour += 12;
  if (marker === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function findDates(text: string, now: Date): DateHit[] {
  const hits: DateHit[] = [];
  const year = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  const push = (
    index: number,
    end: number,
    y: number | null,
    m: number,
    d: number
  ) => {
    let date = iso(y ?? year, m, d);
    if (date && y === null && date < today) date = iso(year + 1, m, d);
    if (!date) return;
    const time = timeAfter(text, end);
    hits.push({
      index,
      date,
      ...(time ? { time } : {}),
      explicitYear: y !== null,
    });
  };
  let m: RegExpExecArray | null;
  const isoRe = /\b(20\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/g;
  while ((m = isoRe.exec(text))) {
    const date = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!date) continue;
    const time = m[4]
      ? `${m[4]}:${m[5]}`
      : timeAfter(text, m.index + m[0].length);
    hits.push({
      index: m.index,
      date,
      ...(time ? { time } : {}),
      explicitYear: true,
    });
  }
  const dmy = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(${MONTH_RE})\\.?,?(?:\\s+(20\\d{2}))?\\b`,
    "gi"
  );
  while ((m = dmy.exec(text))) {
    const month = monthOf(m[2]!);
    if (month) {
      push(
        m.index,
        m.index + m[0].length,
        m[3] ? Number(m[3]) : null,
        month,
        Number(m[1])
      );
    }
  }
  const mdy = new RegExp(
    `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d{2}))?`,
    "gi"
  );
  while ((m = mdy.exec(text))) {
    const month = monthOf(m[1]!);
    if (month) {
      push(
        m.index,
        m.index + m[0].length,
        m[3] ? Number(m[3]) : null,
        month,
        Number(m[2])
      );
    }
  }
  const numeric = /\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g;
  while ((m = numeric.exec(text))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Day first unless that cannot be a date (13/… is a day, …/13 is not a month).
    const [d, mo] = b > 12 ? [b, a] : [a, b];
    push(m.index, m.index + m[0].length, Number(m[3]), mo, d);
  }
  return hits.sort((x, y) => x.index - y.index);
}

function detectDates(text: string, title: string, now: Date): LibraryAction[] {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(
    now.getTime() + LIBRARY_ACTION_LIMITS.dateHorizonDays * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  const out: LibraryAction[] = [];
  const seen = new Set<string>();
  for (const hit of findDates(text, now)) {
    // A calendar chip is for what is coming, not for a date the page mentions.
    if (hit.date < today || hit.date > horizon || seen.has(hit.date)) continue;
    const sentence = sentenceAt(text, hit.index);
    const eventy = EVENT_WORDS.test(sentence) || EVENT_WORDS.test(title);
    const confidence =
      0.5 +
      (eventy ? 0.25 : 0) +
      (hit.time ? 0.1 : 0) +
      (hit.explicitYear ? 0.05 : 0);
    if (!eventy && !hit.time) continue;
    seen.add(hit.date);
    const eventTitle = clipWords(
      title.trim() || sentence,
      LIBRARY_ACTION_LIMITS.eventTitleMax
    );
    out.push(
      makeAction(
        "date",
        {
          date: hit.date,
          ...(hit.time ? { time: hit.time } : {}),
          ...(eventTitle ? { title: eventTitle } : {}),
        },
        confidence,
        "rule"
      )
    );
  }
  return out;
}

// ── Receipts ───────────────────────────────────────────────────────────────

const RECEIPT_WORDS =
  /\b(receipt|invoice|order\s+(?:confirmation|summary|#|number|no)|amount\s+(?:due|paid)|total|subtotal|payment|paid|purchase|facture|reçu|recu|montant|ticket\s+de\s+caisse|ttc)\b/i;

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
};
const CODE = "EUR|USD|GBP|CHF|CAD|AUD|JPY";
const NUMBER =
  "\\d{1,3}(?:[ \\u00a0.,]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const AMOUNT_RE = new RegExp(
  `(?:([€$£¥])\\s?(${NUMBER}))|(?:\\b(${CODE})\\s?(${NUMBER}))|(?:(${NUMBER})\\s?(€|(?:${CODE})\\b))`,
  "gi"
);

/** "1,234.56" / "1.234,56" / "12,50" / "1 200" → a number. */
export function parseLibraryAmount(raw: string): number | null {
  let s = raw.replace(/[\s ]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);
  if (
    decimalAt >= 0 &&
    s.length - decimalAt - 1 <= 2 &&
    s.length - decimalAt - 1 > 0
  ) {
    const intPart = s.slice(0, decimalAt).replace(/[.,]/g, "");
    s = `${intPart}.${s.slice(decimalAt + 1)}`;
  } else {
    s = s.replace(/[.,]/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const MERCHANT_RES: RegExp[] = [
  /\b(?:receipt|invoice|order)\s+from\s+([A-Z][\w&'.\- ]{1,40}?)(?=[\s,.:;!]*(?:\n|$|for|on|-))/i,
  /\b(?:paid|payment)\s+to\s+([A-Z][\w&'.\- ]{1,40}?)(?=[\s,.:;!]*(?:\n|$|for|on|-))/i,
  /\bthank(?:s| you)\s+for\s+(?:shopping|your\s+order|ordering)\s+(?:at|with)\s+([A-Z][\w&'.\- ]{1,40}?)(?=[\s,.:;!]*(?:\n|$))/i,
];

function detectReceipt(
  text: string,
  title: string,
  siteName: string | undefined,
  now: Date
): LibraryAction[] {
  const haystack = `${title}\n${text}`;
  if (!RECEIPT_WORDS.test(haystack)) return [];
  const amounts: Array<{ amount: number; currency: string; total: boolean }> =
    [];
  let m: RegExpExecArray | null;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(haystack))) {
    const symbol = m[1] ?? (m[6] === "€" ? "€" : undefined);
    const code = (
      m[3] ?? (m[6] && m[6] !== "€" ? m[6] : undefined)
    )?.toUpperCase();
    const currency = code ?? (symbol ? CURRENCY_SYMBOLS[symbol] : undefined);
    const amount = parseLibraryAmount(m[2] ?? m[4] ?? m[5] ?? "");
    if (!currency || amount === null) continue;
    const line = sentenceAt(haystack, m.index).toLowerCase();
    const total =
      /\b(total|amount\s+(?:due|paid)|montant|ttc|grand\s+total)\b/.test(
        line
      ) && !/\bsub-?total\b/.test(line);
    amounts.push({ amount, currency, total });
  }
  if (amounts.length === 0) return [];
  const pick =
    amounts.filter((a) => a.total).pop() ??
    amounts.reduce((best, a) => (a.amount > best.amount ? a : best));
  let merchant: string | undefined;
  for (const re of MERCHANT_RES) {
    const hit = re.exec(haystack);
    if (hit?.[1]) {
      merchant = clipWords(hit[1], 40);
      break;
    }
  }
  merchant ??= siteName?.trim() || undefined;
  const dated = findDates(haystack, new Date(0)).find(
    (d) => d.explicitYear && d.date <= now.toISOString().slice(0, 10)
  );
  return [
    makeAction(
      "receipt",
      {
        amount: pick.amount,
        currency: pick.currency,
        ...(merchant ? { merchant } : {}),
        ...(dated ? { date: dated.date } : {}),
      },
      0.6 + (pick.total ? 0.2 : 0) + (merchant ? 0.05 : 0),
      "rule"
    ),
  ];
}

// ── Contacts ───────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ROBOT_EMAIL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|bounce[s]?|postmaster)@|@(example\.(com|org|net)|sentry\.io)$/i;
const PHONE_RE =
  /(?<![\w+])(\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}(?![\w])/g;
const PHONE_WORDS = /\b(tel|tél|phone|mobile|cell|call|portable|whatsapp)\b/i;

function nameBefore(text: string, index: number): string | undefined {
  // "Ada Lovelace <ada@x.org>" or "Ada Lovelace (ada@x.org)".
  const before = text.slice(Math.max(0, index - 60), index);
  const m = /([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)\s*[<(]\s*$/u.exec(before);
  return m?.[1];
}

function detectContacts(text: string): LibraryAction[] {
  const out: LibraryAction[] = [];
  const usedPhones = new Set<string>();
  const phones: Array<{ index: number; phone: string }> = [];
  let m: RegExpExecArray | null;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text))) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    const intl = m[0].trim().startsWith("+");
    const near = text.slice(Math.max(0, m.index - 30), m.index);
    if (!intl && !PHONE_WORDS.test(near)) continue;
    phones.push({ index: m.index, phone: m[0].trim() });
  }
  const seen = new Set<string>();
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text))) {
    const email = m[0].replace(/\.$/, "");
    const key = email.toLowerCase();
    if (ROBOT_EMAIL.test(email) || seen.has(key)) continue;
    seen.add(key);
    const name = nameBefore(text, m.index);
    const phone = phones.find(
      (p) => Math.abs(p.index - m!.index) < 200 && !usedPhones.has(p.phone)
    );
    if (phone) usedPhones.add(phone.phone);
    out.push(
      makeAction(
        "contact",
        {
          email,
          ...(name ? { name } : {}),
          ...(phone ? { phone: phone.phone } : {}),
        },
        name ? 0.85 : 0.75,
        "rule"
      )
    );
  }
  for (const p of phones) {
    if (usedPhones.has(p.phone)) continue;
    usedPhones.add(p.phone);
    out.push(
      makeAction(
        "contact",
        { phone: p.phone },
        p.phone.startsWith("+") ? 0.7 : 0.65,
        "rule"
      )
    );
  }
  return out;
}

// ── Tasks ──────────────────────────────────────────────────────────────────

const TASK_LINE =
  /^\s*(?:[-*•]\s*)?(?:\[\s?\]\s*|(?:todo|to-?do|to do|task|à faire)\s*[:\-–]\s*)(.{3,})$/i;
const TASK_PHRASE =
  /\b(?:(?:i|we)\s+(?:need|have|must|should)\s+to|remember\s+to|don'?t\s+forget\s+to|ne\s+pas\s+oublier\s+de|il\s+faut)\s+([^.!?\n]{3,120})/gi;

function taskTitle(raw: string): string {
  const t = clipWords(
    raw.replace(/[.;:,\s]+$/, ""),
    LIBRARY_ACTION_LIMITS.taskTitleMax
  );
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function detectTasks(text: string, now: Date): LibraryAction[] {
  const out: LibraryAction[] = [];
  const dueIn = (line: string) =>
    findDates(line, now).find((d) => d.date >= now.toISOString().slice(0, 10))
      ?.date;
  for (const line of text.split("\n")) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    const title = taskTitle(m[1]!);
    const due = dueIn(line);
    out.push(
      makeAction(
        "task",
        { title, ...(due ? { dueDate: due } : {}) },
        0.8,
        "rule"
      )
    );
  }
  let m: RegExpExecArray | null;
  TASK_PHRASE.lastIndex = 0;
  while ((m = TASK_PHRASE.exec(text))) {
    const title = taskTitle(m[1]!);
    const due = dueIn(sentenceAt(text, m.index));
    out.push(
      makeAction(
        "task",
        { title, ...(due ? { dueDate: due } : {}) },
        0.6,
        "rule"
      )
    );
  }
  return out;
}

// ── Merge, cap, normalise ──────────────────────────────────────────────────

/**
 * Rule hits first, then AI suggestions that say something new. Same chip
 * (by {@link libraryActionKey}) ⇒ the first one wins. Capped per kind and in
 * total; chips under the confidence floor are dropped.
 */
export function mergeLibraryActions(
  ...lists: ReadonlyArray<ReadonlyArray<LibraryAction>>
): LibraryAction[] {
  const seen = new Set<string>();
  const perKind = new Map<LibraryActionKind, number>();
  const out: LibraryAction[] = [];
  for (const list of lists) {
    for (const a of list) {
      if (a.confidence < LIBRARY_ACTION_LIMITS.minConfidence) continue;
      const key = libraryActionKey(a.kind, a.value);
      if (seen.has(key)) continue;
      const n = perKind.get(a.kind) ?? 0;
      if (n >= LIBRARY_ACTION_LIMITS.perKind[a.kind]) continue;
      if (out.length >= LIBRARY_ACTION_LIMITS.total) return out;
      seen.add(key);
      perKind.set(a.kind, n + 1);
      out.push(a);
    }
  }
  return out;
}

/** Every deterministic detector over one item. */
export function detectLibraryActions(
  input: LibraryActionInput
): LibraryAction[] {
  const now = input.now ?? new Date();
  const title = (input.title ?? "").trim();
  const body = (input.text ?? "").slice(0, LIBRARY_ACTION_LIMITS.textMax);
  const text = title && !body.startsWith(title) ? `${title}\n${body}` : body;
  return mergeLibraryActions(
    detectReceipt(body, title, input.siteName, now),
    detectDates(text, title, now),
    detectContacts(text),
    detectTasks(text, now)
  );
}

function isKind(v: unknown): v is LibraryActionKind {
  return v === "date" || v === "receipt" || v === "contact" || v === "task";
}

/**
 * Validate the AI's suggestions (untrusted JSON) into chips. A suggestion
 * whose value cannot be run (no date, no amount, no email or phone, no title)
 * is dropped; labels are always rewritten from the value.
 */
export function normalizeLibraryActions(raw: unknown): LibraryAction[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryAction[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!isKind(e.kind)) continue;
    const v =
      e.value && typeof e.value === "object" && !Array.isArray(e.value)
        ? (e.value as Record<string, unknown>)
        : {};
    const confidence =
      typeof e.confidence === "number" && Number.isFinite(e.confidence)
        ? e.confidence
        : 0.6;
    let value: Record<string, unknown> | null = null;
    switch (e.kind) {
      case "date": {
        const date = str(v.date);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) break;
        const time = str(v.time);
        const title = str(v.title);
        value = {
          date,
          ...(time && /^\d{2}:\d{2}$/.test(time) ? { time } : {}),
          ...(title
            ? { title: clipWords(title, LIBRARY_ACTION_LIMITS.eventTitleMax) }
            : {}),
        };
        break;
      }
      case "receipt": {
        const amount =
          typeof v.amount === "number"
            ? v.amount
            : typeof v.amount === "string"
              ? parseLibraryAmount(v.amount)
              : null;
        const currency = str(v.currency)?.toUpperCase();
        if (amount === null || !(amount > 0)) break;
        const merchant = str(v.merchant);
        const date = str(v.date);
        value = {
          amount: Math.round(amount * 100) / 100,
          ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
          ...(merchant ? { merchant: clipWords(merchant, 40) } : {}),
          ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}),
        };
        break;
      }
      case "contact": {
        const email = str(v.email);
        const phone = str(v.phone);
        const name = str(v.name);
        const okEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
        if (!okEmail && !phone) break;
        value = {
          ...(okEmail ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(name ? { name: clipWords(name, 60) } : {}),
        };
        break;
      }
      case "task": {
        const title = str(v.title);
        if (!title) break;
        const dueDate = str(v.dueDate);
        value = {
          title: taskTitle(title),
          ...(dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
            ? { dueDate }
            : {}),
        };
        break;
      }
    }
    if (value) out.push(makeAction(e.kind, value, confidence, "ai"));
  }
  return out;
}

/**
 * Keep what the person already did: a chip of a previous read that was RUN
 * (has a `proposalId`) survives a re-read with that id — re-running a read
 * never forgets a proposal, and never offers the same chip twice.
 */
export function carryRunLibraryActions(
  previous: ReadonlyArray<LibraryAction>,
  next: ReadonlyArray<LibraryAction>
): LibraryAction[] {
  const run = previous.filter((a) => a.proposalId);
  const byKey = new Map(run.map((a) => [libraryActionKey(a.kind, a.value), a]));
  const merged = next.map(
    (a) => byKey.get(libraryActionKey(a.kind, a.value)) ?? a
  );
  const kept = new Set(merged.map((a) => libraryActionKey(a.kind, a.value)));
  return [
    ...merged,
    ...run.filter((a) => !kept.has(libraryActionKey(a.kind, a.value))),
  ];
}
