/**
 * "What is waiting on me?" — a question about the review QUEUE, not about
 * content. Retrieval cannot answer it (the queue is no substrate; `ask`'s
 * pending lane only text-matches proposals against the query's words), so
 * `ask` answers it from the same sections orient's `startHere` reads.
 *
 * Detection is deliberately NARROW: a short question that names the person's
 * own queue (EN + FR). A topical question that merely contains "pending" or
 * "review" ("how does the review process work?") must keep going to recall.
 */
import type { StartHere } from "../discover/discover.js";

export type AskQueueBlock = Pick<
  StartHere,
  "pendingReview" | "owedByPerson" | "openSessions"
>;

/** A queue question is short; a long one is about something else. */
const QUEUE_QUESTION_MAX_WORDS = 12;

const QUEUE_PATTERNS: RegExp[] = [
  // EN: what is waiting / pending / outstanding on me, for me, for my review
  /\bwhat(?:'s|\s+is|\s+are)?\s+(?:still\s+)?(?:waiting|pending|awaiting|outstanding|queued)\b.*\b(?:on|for)\s+(?:me|my)\b/,
  /\banything\s+(?:waiting|pending|outstanding)\s+(?:on|for)\s+me\b/,
  // EN: what do I need to review / approve / decide / answer
  /\bwhat\s+(?:do\s+i|should\s+i)\s+(?:need\s+to|have\s+to)?\s*(?:review|approve|decide|answer|sign\s+off)\b/,
  /\bwhat\s+needs?\s+(?:my\s+)?(?:review|approval|attention|decision|answer)\b/,
  // EN: my queue / inbox
  /\bmy\s+(?:review\s+|approval\s+|pending\s+)?(?:queue|inbox)\b/,
  /\bwhat(?:'s|\s+is)\s+in\s+my\s+(?:review\s+)?(?:queue|inbox)\b/,
  // FR: qu'est-ce qui m'attend / attend de moi / est en attente
  /\bqu['’]?\s*est[-\s]ce\s+qui\s+(?:m['’]\s*attend|attend\s+(?:de\s+moi|après\s+moi|ma\b)|est\s+en\s+attente)/,
  /\bqu['’]?\s*y\s+a[-\s]t[-\s]il\s+(?:à|a)\s+(?:valider|approuver|relire|décider|traiter)\b/,
  // FR: qu'est-ce que je dois valider / approuver / relire / décider / traiter
  /\bqu['’]?\s*est[-\s]ce\s+que\s+je\s+(?:dois|doit)\s+(?:valider|approuver|relire|décider|traiter|répondre)\b/,
  // FR: ma file d'attente / mes validations en attente
  /\bma\s+file\s+d['’]\s*attente\b/,
  /\bmes\s+(?:validations?|approbations?|décisions?|relectures?)\s+en\s+attente\b/,
  /\ben\s+attente\s+de\s+(?:ma|mon|mes)\s+(?:validation|approbation|décision|réponse|relecture)\b/,
];

export function isQueueQuestion(query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q || q.split(" ").length > QUEUE_QUESTION_MAX_WORDS) return false;
  return QUEUE_PATTERNS.some((re) => re.test(q));
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The sentence that LEADS the answer. Deterministic — the IS composes from
 * retrieved items and never sees the queue, so prose from the model could not
 * be trusted to name it. A section that could not be read says so; it is never
 * folded into "nothing waiting".
 */
export function describeQueue(queue: AskQueueBlock): string {
  const parts: string[] = [];
  const unread: string[] = [];

  const pr = queue.pendingReview;
  if ("status" in pr) unread.push("the review queue");
  else if (pr.count > 0) {
    parts.push(
      `${plural(pr.count, "proposal", "proposals")} to review` +
        (pr.oldestDays !== undefined
          ? ` (oldest ${plural(pr.oldestDays, "day", "days")} old${
              pr.oldestLink ? `: ${pr.oldestLink}` : ""
            })`
          : "")
    );
  }
  if (!("status" in pr) && pr.reviewLater) {
    parts.push(
      `${plural(pr.reviewLater, "older proposal", "older proposals")} in Review later`
    );
  }

  const owed = queue.owedByPerson;
  if ("status" in owed) unread.push("the owed answers");
  else if (owed.count > 0) {
    parts.push(
      `${plural(owed.count, "answer or decision", "answers or decisions")} owed ` +
        `across ${plural(owed.sessions, "session", "sessions")}` +
        (owed.countIsLowerBound ? " (at least)" : "")
    );
  }

  const open = queue.openSessions;
  if ("status" in open) unread.push("the open sessions");
  else if (open.count > 0) {
    parts.push(
      `${plural(open.count, "open work session", "open work sessions")}` +
        (open.countIsLowerBound ? " (at least)" : "")
    );
  }

  const unreadNote = unread.length
    ? ` Could not read ${unread.join(", ")} just now — that is not "nothing waiting".`
    : "";
  if (parts.length === 0) {
    return unread.length
      ? `Nothing found waiting on you in what could be read.${unreadNote}`
      : "Nothing is waiting on you: no proposals to review, no owed answers, no open sessions.";
  }
  return `Waiting on you: ${parts.join("; ")}.${unreadNote}`;
}
