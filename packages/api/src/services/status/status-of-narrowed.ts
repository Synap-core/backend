/**
 * `GET /status-of` for a key NARROWED by its grant (`statusOfReach`): which
 * `include` parts it is answered, and the answer cut back to what reads only
 * the subject's own floored record. Pure, so the route and its test share it.
 */
import { STATUS_OF_NARROWED_INCLUDES } from "../../access/grant-door-fence.js";
import type { StatusOfInclude, StatusOfAnswer } from "./status-read.js";

/** What a narrowed answer leaves out, named on the wire so it is never read as empty. */
export const STATUS_OF_WITHHELD_REASON =
  "This key's grant does not read everything a full status answer reads (proposals, slots, holds, roles, the work packet): only the status, its moves and its history are shown, for the ids the grant reaches.";

/** The asked parts split into those a narrowed key is answered and those withheld. */
export function narrowStatusOfInclude(asked: readonly StatusOfInclude[]): {
  include: StatusOfInclude[];
  withheld: StatusOfInclude[];
} {
  const include: StatusOfInclude[] = [];
  const withheld: StatusOfInclude[] = [];
  for (const part of asked)
    (STATUS_OF_NARROWED_INCLUDES.includes(part) ? include : withheld).push(
      part
    );
  return { include, withheld };
}

/**
 * ALLOW-LIST of the answer's own keys a narrowed key keeps. A field added to
 * `StatusOf` later is withheld until someone lists it here
 * (`status-of-narrowed.test.ts` pins this exact set). `live` (is an agent
 * working on a session now), `stuck` (its own step's rule), `category` and
 * `tone` (its status word's class) are derived from the subject's own row, so
 * they are kept; everything that reads proposals, slots, holds or roles by
 * subject id is not listed.
 */
export const STATUS_OF_NARROWED_ANSWER_KEYS = [
  "id",
  "type",
  "name",
  "status",
  "label",
  "category",
  "tone",
  "since",
  "sinceMeasured",
  "stuck",
  "live",
  "moves",
  "history",
  "link",
] as const;

/**
 * ALLOW-LIST of history events: a status move and a stage entered, cut to
 * their plain fields. Dropped: wait episodes (their `ref`, `on` and `reason`
 * name a proposal, session or person read with no grant clause), a role's
 * events (kept only by the facet rule), and every actor, hold, cause and
 * reason, which name people and other objects.
 */
const HISTORY_EVENT_FIELDS: Record<string, readonly string[]> = {
  status_moved: ["id", "kind", "at", "from", "to", "category"],
  stage_entered: ["id", "kind", "at", "stageKey", "fromStage", "via"],
};

function narrowHistory(history: unknown): unknown {
  if (!history || typeof history !== "object") return history;
  const h = history as { events?: unknown; truncated?: unknown };
  if (!Array.isArray(h.events)) return { status: "unavailable" };
  const events = h.events.flatMap((e: Record<string, unknown>) => {
    const fields = HISTORY_EVENT_FIELDS[String(e.kind)];
    if (!fields || e.role != null || e.facetId != null) return [];
    return [Object.fromEntries(fields.map((k) => [k, e[k]]))];
  });
  return { events, truncated: h.truncated === true };
}

/** One answer cut back; an `unknown` id is returned as is. */
export function narrowStatusOfAnswer(answer: StatusOfAnswer): StatusOfAnswer {
  if (answer.type === "unknown") return answer;
  const src = answer as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of STATUS_OF_NARROWED_ANSWER_KEYS)
    if (key in src) out[key] = key === "history" ? narrowHistory(src[key]) : src[key];
  return out as unknown as StatusOfAnswer;
}
