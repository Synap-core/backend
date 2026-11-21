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

/** Keys of a full answer that read beyond the subject (see `statusOfReach`). */
const BEYOND_THE_SUBJECT = [
  "waitingOn",
  "blocker",
  "nextMove",
  "hold",
  "roles",
  "account",
  "reactions",
  "links",
  "rollup",
  "signals",
  "work",
] as const;

/** One answer cut back; an `unknown` id is returned as is. */
export function narrowStatusOfAnswer(answer: StatusOfAnswer): StatusOfAnswer {
  if (answer.type === "unknown") return answer;
  const out: Record<string, unknown> = { ...answer };
  for (const key of BEYOND_THE_SUBJECT) delete out[key];
  return out as unknown as StatusOfAnswer;
}
