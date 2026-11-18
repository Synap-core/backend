/**
 * The episodic lane's noise, removed before its items become `sources`
 * (ticket d1fe02c8). Live, 2026-11-17: "What did I decide about how failed
 * proposals should be handled?" came back with four identical "Ran capability
 * \"market.search\" → {\"entries\":[],…}" lines as its first four sources,
 * while the relevant record was cut by the source cap.
 *
 * Two rules, nothing tuned:
 *   - the SAME fact text twice is one source (the first, the best ranked);
 *   - a capability run that returned nothing (`→` a JSON object whose list
 *     fields are all empty) is a log line, not something the person knows.
 * A run whose result does not parse (the deposit is cut at 1,000 chars) or
 * carries anything is kept: it may be the answer.
 */

/** The prefix every capability-run deposit carries (`execute-capability.ts`). */
const TOOL_RUN = /^Ran capability "[^"]*" → ([\s\S]*)$/;

function factText(item: Record<string, unknown>): string | null {
  return typeof item.fact === "string" ? item.fact.trim() : null;
}

/** A run that returned no rows: a JSON object with list fields, all empty. */
export function isEmptyToolRun(fact: string): boolean {
  const body = TOOL_RUN.exec(fact)?.[1];
  if (body === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (!parsed || typeof parsed !== "object") return false;
  const lists = Object.values(parsed).filter(Array.isArray);
  return lists.length > 0 && lists.every((list) => list.length === 0);
}

/** The episodic items, first of each fact text, empty runs dropped. */
export function withoutEpisodicNoise<T extends Record<string, unknown>>(
  items: readonly T[]
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const text = factText(item);
    if (text === null) return true;
    if (seen.has(text) || isEmptyToolRun(text)) return false;
    seen.add(text);
    return true;
  });
}
