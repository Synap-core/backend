/**
 * synthesizeAnswer — shared retrieve→synthesize pipeline used by BOTH:
 *   - POST /knowledge/answer  (hub-protocol REST handler)
 *   - synap_ask MCP tool      (MCP adapter)
 *
 * Takes the raw `AskResult.answers` blocks, builds a compact context string,
 * calls the IS `/api/knowledge/answer` synthesis endpoint, and returns a
 * uniform result object. Falls back gracefully when the IS is unavailable.
 *
 * Callers own the HTTP response layer (c.json / return ok) — this function
 * returns a plain object so behaviour at both call sites stays byte-identical.
 */

import type { AskAnswer } from "./ask.js";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";
import { isCallBudgetMs } from "@synap/intelligence-client";
import {
  classifyAiFailure,
  type AiFailureClass,
} from "../../utils/ai-failure.js";

const logger = createLogger({ module: "knowledge-synthesize" });

export interface SynthesisSource {
  substrate: string;
  id: string;
  title: string;
}

export interface SynthesisResult {
  answer: string | null;
  sources: SynthesisSource[];
  /** Which substrates were queried (forwarded from AskResult). */
  routedTo: string[];
  /** Present only on IS unavailability — callers surface sources instead. */
  error?: "synthesis_unavailable";
  /**
   * WHY synthesis was unavailable, classified from the real error by the one
   * failure door (utils/ai-failure.ts). Present only alongside `error`, so a
   * caller can tell the user "the provider is out of credit, retrying will not
   * help" instead of inventing a temporary outage.
   */
  failureClass?: AiFailureClass;
  /**
   * Present ONLY when the context budget dropped retrieved items — mirrors the
   * `error`/`failureClass` "present only when it happened" convention above.
   * Machine-detectable, unlike the prose `[NOTICE]` line inside `context`:
   * that notice only reaches the reader if the model chooses to repeat it, and
   * is lost entirely when the IS call fails (the catch branch below still
   * populates this field, since `buildSynthesisContext` runs before any
   * network call — the omission is real whether or not synthesis succeeded).
   */
  truncated?: { omitted: number; total: number };
}

/**
 * HARD CONTRACT WITH THE CALLEE — do NOT raise without raising the IS first.
 *
 * The IS synthesis route validates its body with
 * `context: z.string().max(20000)`
 * (`intelligence-hub/src/routes/knowledge-answer.ts`). This constant sat at
 * 40_000, so any context between 20k and 40k chars was built, sent, and
 * rejected by zod with HTTP 400 — which `classifyAiFailure` (correctly) reports
 * as `bad_request` / `retryable: false`. The user saw "synthesis_unavailable"
 * with a non-retryable failure and no answer at all.
 *
 * Measured on the team pod, `ask "list our clients"` (34 sources) built a
 * 29,670-char context → guaranteed 400. The same pod's `ask "what is PeerPesa"`
 * (8 sources) synthesized fine. Nothing but size differed.
 *
 * The two constants are a cross-repo pair with no shared source of truth, so
 * this one is pinned to the SMALLER of the two and the overflow is reported to
 * the model (see `TRUNCATION_NOTICE`) instead of dropped in silence.
 */
const MAX_CONTEXT_CHARS = 20_000;
/**
 * Chars reserved inside the budget so the truncation notice itself can always
 * be appended — a notice that got budget-dropped would defeat its own purpose.
 *
 * Raised from 200 → 300 to make room for `buildTruncationNotice`'s omitted-item
 * NAMES (previously just a count: "8 of 20 items were omitted", which tells the
 * model NOTHING was retrievable when in fact it was retrieved and only failed to
 * fit — the model then says "I couldn't find that" instead of "I found X but
 * could not read it"). `buildTruncationNotice` hard-slices to this reserve
 * regardless, so the 20k IS cap can never be exceeded even if this constant is
 * ever under-sized for its own template.
 */
const TRUNCATION_NOTICE_RESERVE = 300;
/** How many omitted item titles the truncation notice names before "+N more". */
const TRUNCATION_NOTICE_MAX_NAMES = 3;
/** Per-name slice inside the truncation notice — keeps the notice bounded even
 * when a source title is itself very long. */
const TRUNCATION_NOTICE_TITLE_CHARS = 30;
/** Per-snippet-field slice — generous enough to carry a real body/verdict/
 * conclusion instead of the old 300-char stub, while MAX_CONTEXT_CHARS still
 * bounds the total context sent to the IS. */
const MAX_FIELD_CHARS = 1500;
/**
 * Procedural rows (`knowledge_keys`) get a LARGER slice than an entity field.
 *
 * Measured, not guessed: with `MAX_FIELD_CHARS`, asking the pod "why is the
 * cost chokepoint in buildClient and not callCascade?" returned the runbook's
 * opening (what was built) and then said "the context does not explicitly
 * explain WHY" — because the WHY section sits ~1,800 chars into a ~4,000-char
 * note. A curated runbook is a whole document written to be recalled, not one
 * field of a record, and the answer-bearing part is routinely NOT the opening.
 * Procedural hits are also few (single digits) where entity hits are many, so
 * the extra budget lands where it buys the most and costs the least.
 *
 * `MAX_CONTEXT_CHARS` still bounds the total; it was raised alongside this so
 * a couple of long runbooks cannot silently push every other source out of the
 * context window (the loop DROPS remaining items once the cap is hit — a
 * budget too large is its own failure mode, just a quieter one).
 */
const MAX_PROCEDURAL_CHARS = 6_000;
/**
 * Max procedural (`knowledge_keys`) rows ADMITTED into the context, independent
 * of the byte budget below. `MAX_PROCEDURAL_CHARS` alone doesn't bound how many
 * runbooks get in — three of them (3 × ~6,100 chars incl. title/prefix
 * overhead ≈ 18,300) consume 93% of the ~19,700-char budget (`MAX_CONTEXT_CHARS
 * - TRUNCATION_NOTICE_RESERVE`), leaving ~1,400 chars — less than ONE entity
 * entry (title + `content: `-slice ≈ 1,565 chars at `MAX_FIELD_CHARS`) — for
 * every semantic/structured/episodic hit combined. That is the same starvation
 * bug 1a fixes for a single long item, just caused by several medium ones.
 *
 * 2, not 3: capped at 2 rows (2 × ~6,100 ≈ 12,200), the remaining ~7,500 chars
 * (≈38% of budget) still fits ~4-5 entity entries — real room for the other
 * substrates, where 3 rows leaves essentially none. Procedural hits are also
 * few per query (single digits, usually 1-2 relevant runbooks) per the
 * measurement note above `MAX_PROCEDURAL_CHARS` — 2 covers the common case
 * without reintroducing the starvation the cap exists to prevent.
 *
 * Does NOT apply to the rank-1 protected item (see `admittedFirst` below): if
 * the single highest-ranked result happens to be procedural, excluding it via
 * this cap would reintroduce the exact "rank-1 dropped" bug 1a fixes.
 */
const MAX_PROCEDURAL_ROWS = 2;
/** Common JSONB `properties` keys that hold prose worth surfacing verbatim. */
const PROPERTY_TEXT_KEYS = [
  "content",
  "conclusion",
  "description",
  "summary",
  "body",
  "notes",
];

/**
 * Lead with an honest acknowledgment when the caller has matching pending
 * capture proposals — WITHOUT fabricating their content as fact. Guarded by a
 * substring check so we never double-prepend if the IS's own answer already
 * surfaced them.
 *
 * MUST come first, not last: `data.answer` is free-text generated by the IS
 * LLM (no hardcoded/flagged "nothing found" string exists to detect — see
 * `/api/knowledge/answer`'s system prompt), so a "no information found" style
 * opener is common and indistinguishable from real content by string-matching
 * alone. Appending the pending note AFTER such an opener meant the reader saw
 * "nothing" first and only self-corrected afterward. Leading with it instead
 * means a pending-only result never reads as a flat "no information found",
 * whether or not the IS's own text happened to be empty-shaped.
 */
/**
 * Prepend a DEGRADATION notice, for the same reason `prependPendingNotice`
 * exists one function below: the IS composes `answer` from `answers` alone and
 * never sees the retrieval envelope, so a half-dead substrate produced a
 * fluent, confident answer built on whatever happened to survive.
 *
 * Measured, live: with `degraded: ["semantic:vector-down"]` exactly ONE source
 * matched — an unrelated engineering note — and the synthesis answered a
 * question about twelve business bets from it, formatted and plausible, with
 * nothing in the prose indicating the retrieval layer was down. The signal was
 * present and CORRECT in the envelope the whole time; only the sentence the
 * agent actually reads was silent.
 *
 * This is the third variant of one class across four external test passes
 * (answered-when-absent, failed-honestly, half-failed-silently). The class is:
 * every degradation signal must reach the PROSE, not just the envelope.
 *
 * Leading, not trailing — same rationale as the pending notice: the reader
 * must see the caveat before the content it qualifies.
 */
function prependDegradedNotice(answer: string, degraded: string[]): string {
  if (degraded.length === 0) return answer;
  // Do not double-announce if the model already hedged about the outage.
  if (/degrad|unavailable|could not search|retrieval (is )?down/i.test(answer))
    return answer;
  return (
    `\u26a0 Retrieval was DEGRADED for this answer (${degraded.join(", ")}), so ` +
    `the sources below are incomplete and this answer may miss or misattribute ` +
    `material. Treat it as partial, and re-ask once healthy before relying on it.\n\n` +
    answer
  );
}

function prependPendingNotice(answer: string, pendingCount: number): string {
  if (pendingCount <= 0 || /pending/i.test(answer)) return answer;
  const plural = pendingCount === 1 ? "" : "s";
  const verb = pendingCount === 1 ? "matches" : "match";
  return (
    `${pendingCount} pending proposal${plural} already ${verb} this — not yet ` +
    `in the graph; review them before treating this as unknown, and do NOT ` +
    `re-capture. ${answer}`
  );
}

/**
 * Build context + sources from retrieved answer blocks, then call the IS
 * synthesis endpoint. Returns a SynthesisResult regardless of IS availability.
 */
/**
 * Build the model-facing context block + the source list from raw substrate
 * answers. Extracted PURE (no network, no db) so the field-budget contract is
 * testable directly — the same reason `shapeAgentSpend` is pure in the event
 * repository. `synthesizeAnswer` is otherwise an IS round-trip and cannot be
 * asserted on cheaply.
 */
export function buildSynthesisContext(answers: AskAnswer[]): {
  sources: SynthesisSource[];
  context: string;
  /** Present only when items were dropped — see `SynthesisResult.truncated`. */
  truncated?: { omitted: number; total: number };
} {
  const sources: SynthesisSource[] = [];
  const contextParts: string[] = [];
  let contextLen = 0;
  /**
   * Retrieved items that did NOT fit the budget. Counted, not ignored: the
   * structured lane deliberately over-fetches (`ask.ts` forces `limit >= 200`
   * because "enumeration promises the COMPLETE set"), so a budget cut can
   * silently turn a complete list into a partial one. Reporting the shortfall
   * lets the model say "showing N of M" instead of presenting a truncated list
   * as exhaustive — the same honesty rule the failure path already follows.
   */
  let omitted = 0;
  /** Titles of omitted items, in omission order — named in the notice below so
   * the model can say "I found X but could not read it" instead of "I couldn't
   * find that". */
  const omittedTitles: string[] = [];
  const budget = MAX_CONTEXT_CHARS - TRUNCATION_NOTICE_RESERVE;
  let totalItems = 0;
  /**
   * Rank-1 protection: the loop below admits by FIT, not RANK, so without this
   * a short low-ranked item could be admitted ahead of a long high-ranked one —
   * the single most-relevant retrieved item could be the one item dropped.
   * `answers` is primary-substrate-first and each block's items are already
   * rank-ordered (`ask.ts`), so the very first item this loop sees is the
   * single highest-ranked retrieved item across the whole result — admit it
   * unconditionally, before any budget check.
   *
   * Provably safe against the 20k IS cap: the largest field slice is
   * MAX_PROCEDURAL_CHARS (6,000) plus a handful of MAX_FIELD_CHARS (1,500)
   * slices, well under the ~19.7k budget — EXCEPT `title` itself is NOT
   * capped by any of those slices (it can fall back to `rec.content`
   * unsliced when an entity's `title` column is null — see the fallback
   * chain below, and `content` can carry a 64k-char document preview per
   * `retrieve.ts`'s `fetchOrdered`). So the unconditional admit below still
   * hard-slices its entry to `budget` chars as a safety net — this is the
   * ONLY place that slice applies; every other item's entry is still
   * dropped whole (not truncated) when it doesn't fit, unchanged.
   */
  let admittedFirst = false;
  /** Procedural rows admitted so far — see `MAX_PROCEDURAL_ROWS`. */
  let proceduralAdmitted = 0;

  for (const block of answers) {
    if (block.status !== "ok") continue;
    const isProcedural = block.substrate === "procedural";
    for (const item of block.items) {
      totalItems++;
      const isProtectedFirst = !admittedFirst;

      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const title =
        (typeof rec.name === "string" && rec.name) ||
        (typeof rec.title === "string" && rec.title) ||
        (typeof rec.claim === "string" && rec.claim) ||
        (typeof rec.fact === "string" && rec.fact) ||
        (typeof rec.content === "string" && rec.content) ||
        // Procedural rows (knowledge_keys) carry NONE of the above — their
        // human name is `key` ("namespace:slug"). Without this they fell all
        // the way through to the raw UUID, so every runbook source rendered as
        // an opaque id the reader (and the model) could not identify.
        (typeof rec.key === "string" && rec.key) ||
        id ||
        "(item)";

      if (id) sources.push({ substrate: block.substrate, id, title });

      // Procedural-row cap — independent of the byte budget check below (see
      // `MAX_PROCEDURAL_ROWS`). Skipped for the protected-first item: rank-1
      // is admitted unconditionally regardless of substrate.
      if (
        !isProtectedFirst &&
        isProcedural &&
        proceduralAdmitted >= MAX_PROCEDURAL_ROWS
      ) {
        omitted++;
        omittedTitles.push(String(title));
        continue;
      }

      if (!isProtectedFirst && contextLen >= budget) {
        omitted++;
        omittedTitles.push(String(title));
        continue;
      }

      // Snippet: title + the entity BODY + a few key string props. The body
      // is the fix — without it synthesis only ever saw title/metadata and
      // could never answer questions whose answer lives in the content.
      const snippetBits: string[] = [String(title)];

      // 1. The attached document body (retrieve.ts's `fetchOrdered` join) —
      //    the actual long-form content, not a metadata field.
      if (typeof rec.content === "string" && rec.content.trim()) {
        snippetBits.push(`content: ${rec.content.slice(0, MAX_FIELD_CHARS)}`);
      }

      // 1b. Procedural runbooks (knowledge_keys) keep their whole body in
      //     `value`. It is not `content` and not inside `properties`, so it
      //     used to fall through to the generic 300-char branch below — a
      //     runbook is routinely thousands of characters, so synthesis saw
      //     only its opening lines and would answer "I cannot find that"
      //     while holding the exact note that answered it. `value` IS the
      //     document here, so it gets the same budget `content` does.
      if (typeof rec.value === "string" && rec.value.trim()) {
        snippetBits.push(`value: ${rec.value.slice(0, MAX_PROCEDURAL_CHARS)}`);
      }

      // 2. Prose buried inside the JSONB `properties` object — previously
      //    dropped entirely because it's an object, not a top-level string.
      if (rec.properties && typeof rec.properties === "object") {
        const props = rec.properties as Record<string, unknown>;
        for (const key of PROPERTY_TEXT_KEYS) {
          const v = props[key];
          if (typeof v === "string" && v.trim()) {
            snippetBits.push(`${key}: ${v.slice(0, MAX_FIELD_CHARS)}`);
          }
        }
      }

      // 3. Fall back to other short top-level string props (pre-existing
      //    behavior), skipping fields already handled above.
      for (const [k, v] of Object.entries(rec)) {
        if (
          ["id", "name", "title", "content", "properties", "value"].includes(k)
        )
          continue;
        if (typeof v === "string" && v.trim()) {
          snippetBits.push(`${k}: ${v.slice(0, 300)}`);
        }
        if (snippetBits.length >= 8) break;
      }
      const entry = `- [${block.substrate}] ${snippetBits.join(" · ")}`;
      if (!isProtectedFirst && contextLen + entry.length > budget) {
        omitted++;
        omittedTitles.push(String(title));
        continue;
      }
      // Safety net for the rank-1 unconditional admit ONLY (see the comment on
      // `admittedFirst` above): guarantee this single entry can never itself
      // exceed the budget, however large its unsliced `title` fallback turned
      // out to be. Every other entry is dropped whole, never truncated — this
      // hard slice cannot fire for them because they already passed the fit
      // check above.
      const admittedEntry =
        isProtectedFirst && entry.length > budget
          ? entry.slice(0, budget)
          : entry;
      contextParts.push(admittedEntry);
      contextLen += admittedEntry.length + 1;
      admittedFirst = true;
    }
  }

  // NOTE the loops no longer `break` on the budget: they keep scanning so
  // `omitted` is a true count of what was left out, not "we stopped here".
  // `sources` is unaffected by the budget — the caller still lists every match.
  if (omitted > 0) {
    contextParts.push(
      buildTruncationNotice(omitted, totalItems, omittedTitles)
    );
  }

  return { sources, context: contextParts.join("\n") };
}

/**
 * The truncation notice — named, not just counted. `omittedTitles` are already
 * in hand (every retrieved item's title is computed and pushed to `sources`
 * before the budget check runs, omitted or not), so instead of "8 of 20
 * retrieved items were omitted" the model gets "…omitted: "BET 12 — …",
 * "BET 7 — …"" and can say "I found BET 12 but could not read it" instead of
 * "I couldn't find that". Hard-slices to `TRUNCATION_NOTICE_RESERVE` as a
 * safety net regardless of how long the omitted titles happen to be, so the
 * notice can never itself push the total context past the 20k IS cap.
 */
function buildTruncationNotice(
  omitted: number,
  totalItems: number,
  omittedTitles: string[]
): string {
  const shown = omittedTitles
    .slice(0, TRUNCATION_NOTICE_MAX_NAMES)
    .map((t) => `"${t.slice(0, TRUNCATION_NOTICE_TITLE_CHARS)}"`);
  const remaining = omittedTitles.length - shown.length;
  const names =
    shown.length > 0
      ? ` (omitted: ${shown.join(", ")}${remaining > 0 ? ` +${remaining} more` : ""})`
      : "";
  const notice =
    `- [NOTICE] CONTEXT TRUNCATED: ${omitted} of ${totalItems} retrieved ` +
    `items did not fit and are NOT shown above${names}. Any list you produce ` +
    `from this context is PARTIAL — say so explicitly and give the counts.`;
  return notice.length > TRUNCATION_NOTICE_RESERVE
    ? notice.slice(0, TRUNCATION_NOTICE_RESERVE)
    : notice;
}

export async function synthesizeAnswer(
  answers: AskAnswer[],
  question: string,
  routedTo: string[],
  workspaceId: string | null | undefined,
  /**
   * Count of the caller's OWN pending capture proposals that text-matched this
   * query (`AskResult.pending.matches.length`). The IS composes `answer` from
   * `answers` alone — it never sees the pending lane, so a query with matching
   * pending proposals but nothing in the graph yet came back "no information
   * found" sitting right next to a non-empty pending block: a self-contradiction.
   * When >0, we PREPEND one acknowledgment sentence to the synthesized answer
   * (unless it already mentions pending) — never fabricating pending CONTENT as
   * fact, just pointing at the block below. Leading (not trailing) matters: the
   * IS answer is free text with no detectable "nothing found" flag, so a
   * negative-sounding opener must never be the first thing the reader sees when
   * pending matches exist. Optional/defaults to 0 so other callers of
   * synthesizeAnswer are unaffected.
   */
  pendingCount = 0,
  /**
   * `AskResult.degraded` — which retrieval substrates failed or fell back for
   * THIS query. Threaded in for the same reason as `pendingCount`: the IS
   * cannot see it, and an answer synthesized over a half-empty candidate pool
   * is indistinguishable, in prose, from a healthy one.
   */
  degraded: string[] = []
): Promise<SynthesisResult> {
  const { sources, context } = buildSynthesisContext(answers);

  // Call the IS "answer" door — one focused LLM call. Resolve the IS endpoint +
  // the pod's PER-CONNECTION key from the DB (registered IS), NEVER from env.
  let isUrl = "";
  try {
    const { endpoint, apiKey } = await getDefaultActiveService();
    isUrl = endpoint;
    const res = await fetch(`${isUrl}/api/knowledge/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        question,
        context,
        workspaceId: workspaceId ?? undefined,
      }),
      // `generation` budget, not a literal. This is a model call (the IS
      // synthesizes an answer over retrieved context), so it carries the same
      // reasoning-model exposure as the 2026-07-31 incident — and its `context`
      // grows with corpus size, exactly the variable that made 60s bite there.
      signal: AbortSignal.timeout(isCallBudgetMs("generation")),
    });
    if (!res.ok) throw new Error(`IS answer HTTP ${res.status}`);
    const data = (await res.json()) as { answer?: string };
    const answer =
      typeof data.answer === "string"
        ? prependDegradedNotice(
            prependPendingNotice(data.answer, pendingCount),
            degraded
          )
        : null;
    return {
      answer,
      sources,
      routedTo,
    };
  } catch (err) {
    // Synthesis unavailable — return sources so callers can still show matches.
    // Log the real cause: this is a pod→IS transport/auth/route failure (the IS
    // returns 200 even on LLM errors), NOT an LLM failure — without this line the
    // cause (ECONNREFUSED / 401 key drift / 404 stale-route) is invisible.
    logger.error(
      { err, isUrl },
      "knowledge synthesis call to IS failed — returning sources without answer"
    );
    return {
      answer: null,
      sources,
      routedTo,
      error: "synthesis_unavailable",
      failureClass: classifyAiFailure(err),
    };
  }
}
