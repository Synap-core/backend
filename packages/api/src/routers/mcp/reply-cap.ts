/**
 * THE reply cap: one door, every MCP tool reply.
 *
 * WHY: no tool reply had a ceiling, so one read could cost tens of thousands
 * of tokens (`synap_get_session` measured 120,612 chars, finding 3a849acf), and
 * Claude Code silently drops the end of anything over its own limit. A reply
 * over the budget now comes back as valid JSON that SAYS what was left out and
 * how to narrow the call, never silently cut.
 *
 * HOW (finding 18becda0, 2026-11-18): a JSON object reply is FITTED
 * (`fitReply`): whole rows dropped from the end of its largest lists, long
 * strings clipped, with a `fit` notice naming each. A paged list reply whose
 * own rows were cut gets `nextOffset` at the first row left out, so the next
 * call reads on and nothing is lost. The old cut (the first characters of the
 * text as a string in `head`) left broken JSON with no way on, and agents
 * went around the MCP to raw Hub calls to get the data. That cut stays only
 * for a reply that is not a JSON object.
 *
 * A reply within budget is returned untouched (the same object). Errors are
 * never capped: an error text must reach the caller whole.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fitReply } from "./handlers/fit-reply.js";
import { REPLY_CAP_CHARS } from "./reply-cap-budget.js";

export { REPLY_CAP_CHARS };

/**
 * Tools whose reply IS a body the caller asked to read whole (a skill's text
 * is what `synap_load_skill` is for). Capping them would break the tool. A new
 * entry needs a reason here; `reply-cap.test.ts` pins this list.
 */
export const REPLY_CAP_EXEMPT: ReadonlySet<string> = new Set([
  "synap_load_skill",
]);

const GENERIC_HOW =
  "Narrow the call: a smaller `limit`, a `detail` or `fields` parameter where the tool has one, or a more specific id or query.";

/**
 * How to get less back, in the tool's own parameters. Every parameter named
 * here must be declared by that tool (`reply-cap.hints.test.ts` pins it).
 */
export const HOW_TO_NARROW: Readonly<Record<string, string>> = {
  synap_get_session:
    "Call again with detail:'lean' (the outcomes, what is owed, the next move, the last room posts).",
  synap_get_entity:
    "Call again with detail:'lean', or read the properties you need with synap_get_entities {fields}.",
  synap_get_entities:
    "Lower `limit`, pass `fields`, and page with `offset` (use `nextOffset`).",
  synap_get_document:
    "Read the body in slices: pass `limit` (characters) and `offset` (the previous `nextOffset`).",
  synap_get_graph:
    "Lower `limit` and page the neighbours with `offset` (use `nextOffset`).",
  synap_get_relations: "Lower `limit` (the newest relations come first).",
  synap_ask: "Call again with detail:'brief' or 'sources', or a lower `limit`.",
  synap_find:
    "Lower `limit` (matches per catalog), or name only the `catalogs` you need.",
  synap_list_proposals:
    "Lower `limit`, page with `offset` (use `nextOffset`), or use detail:'summary'.",
  synap_list_profiles:
    "Lower `limit` and page with `offset` (use `nextOffset`).",
  synap_list_views:
    "Lower `limit` and page with `offset` (use `nextOffset`); detail:'lean' is the default.",
  synap_list_capabilities:
    "Lower `limit` and page with `offset` (use `nextOffset`), or pass a `query` or `kind`.",
  synap_list_automations:
    "Lower `limit` and page with `offset` (use `nextOffset`); detail:'lean' is the default.",
  synap_list_playbooks:
    "Lower `limit` and page with `cursor` (use `nextCursor`); detail:'lean' is the default.",
  synap_list_widgets:
    "Lower `limit` and page with `offset` (use `nextOffset`).",
  synap_list_sessions: "Lower `limit` and page with `offset`.",
  synap_list_workspaces: "Lower `limit` and page with `offset`.",
  synap_list_tracks:
    "Pass `name`, or lower `limit` and page with `offset`; detail:'lean' is the default.",
  synap_list_agents: "Lower `limit` and page with `offset`.",
  synap_get_thread_context:
    "Lower `limit`, and read older messages with `cursor` (the previous `nextCursor`).",
  synap_read_board:
    "Lower `limit` and page with `offset` (use `scene.window.nextOffset`), or read one frame with `frameId`.",
  synap_orient:
    "Pass `scope` and/or `workspaceId`; a worker polling its hand-offs passes only:'handedToYou'.",
};

function envelope(
  text: string,
  headChars: number,
  budget: number,
  toolName: string
): string {
  return JSON.stringify({
    truncated: {
      reason: `The reply was ${text.length} characters; the limit is ${budget}. Only the start of it is shown in \`head\`.`,
      totalChars: text.length,
      shownChars: headChars,
      omittedChars: text.length - headChars,
      how: HOW_TO_NARROW[toolName] ?? GENERIC_HOW,
    },
    head: text.slice(0, headChars),
  });
}

/** Room the fitted reply keeps for its `fit` notice and `nextOffset`. */
const FIT_NOTICE_ROOM = 1_200;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Where a paged reply keeps its offset: top-level `offset` / `nextOffset`
 * (the DB-paged doors) or `paging.offset` (`pageSlice`). `null` = not paged.
 */
function pagingOf(
  reply: Record<string, unknown>
): { offset: number; holder: "top" | "paging" } | null {
  if (typeof reply.offset === "number") {
    return { offset: reply.offset, holder: "top" };
  }
  if (isPlainObject(reply.paging) && typeof reply.paging.offset === "number") {
    return { offset: reply.paging.offset, holder: "paging" };
  }
  return null;
}

/**
 * `key` when it is the list `offset` walks: a top-level list, the largest
 * one, whose length agrees with every page fact the handler wrote (`count`,
 * `nextOffset - offset`, a last page's `total - offset`). A side list (e.g.
 * `warnings`) fails one of them, and a wrong `nextOffset` would skip or repeat
 * rows, so when in doubt there is none: the `fit` notice still says what was
 * left out.
 */
function pageList(
  reply: Record<string, unknown>,
  key: string | undefined,
  paging: { offset: number; holder: "top" | "paging" }
): string | null {
  if (key === undefined || !Array.isArray(reply[key])) return null;
  const size = (k: string) => JSON.stringify(reply[k]).length;
  const largest = Object.keys(reply)
    .filter((k) => Array.isArray(reply[k]))
    .reduce((a, b) => (size(b) > size(a) ? b : a));
  if (largest !== key) return null;
  const len = (reply[key] as unknown[]).length;
  const facts =
    paging.holder === "paging"
      ? (reply.paging as Record<string, unknown>)
      : reply;
  const agrees = (fact: unknown, expected: number) =>
    typeof fact !== "number" || fact === expected;
  const ok =
    agrees(facts.count, len) &&
    agrees(facts.nextOffset, paging.offset + len) &&
    (typeof facts.nextOffset === "number" ||
      agrees(facts.total, paging.offset + len));
  return ok ? key : null;
}

/**
 * The reply fitted under `budget`, or `null` when it is not a JSON object or
 * cannot be fitted. A paged reply whose ONE page list was cut reads on from
 * the first row left out: `nextOffset` replaces the handler's (which would
 * skip the rows dropped here), and `count` follows the rows shown.
 */
function fitted(
  text: string,
  budget: number,
  toolName: string
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const how = HOW_TO_NARROW[toolName] ?? GENERIC_HOW;
  const out: Record<string, unknown> = fitReply(parsed, {
    budget: budget - FIT_NOTICE_ROOM,
    how: `Lists in \`fit.omitted\` kept their first items; strings in \`fit.clipped\` their start. ${how}`,
  });
  const fit = out.fit as
    | { omitted: Record<string, number>; how: string }
    | undefined;
  if (!fit) {
    // Fitted with nothing left out (the handler's JSON was only spaced out).
    const json = JSON.stringify(out);
    return json.length <= budget ? json : null;
  }
  const cut = Object.keys(fit.omitted);
  const paging = pagingOf(parsed);
  const page =
    paging && cut.length === 1 ? pageList(parsed, cut[0], paging) : null;
  if (paging && page && Array.isArray(out[page])) {
    const shown = (out[page] as unknown[]).length;
    const nextOffset = paging.offset + shown;
    if (paging.holder === "paging") {
      out.paging = { ...(out.paging as Record<string, unknown>), nextOffset };
    } else {
      out.nextOffset = nextOffset;
    }
    if (
      typeof parsed.count === "number" &&
      parsed.count === (parsed[page] as unknown[]).length
    ) {
      out.count = shown;
    }
    fit.how = `The rows left out are on the next page: call again with offset: ${nextOffset}. ${how}`;
  }
  const json = JSON.stringify(out);
  return json.length <= budget ? json : null;
}

export function capReply(
  toolName: string,
  result: CallToolResult,
  budget: number = REPLY_CAP_CHARS
): CallToolResult {
  if (REPLY_CAP_EXEMPT.has(toolName) || result.isError) return result;
  if (!Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map((block) => {
    if (block.type !== "text" || block.text.length <= budget) return block;
    changed = true;
    const fit = fitted(block.text, budget, toolName);
    if (fit !== null) return { ...block, text: fit };
    // The envelope (notice + JSON escaping of the head) must itself fit.
    let head = Math.max(0, budget - 700);
    let out = envelope(block.text, head, budget, toolName);
    while (out.length > budget && head > 0) {
      head = Math.max(0, head - (out.length - budget) - 16);
      out = envelope(block.text, head, budget, toolName);
    }
    return { ...block, text: out };
  });
  return changed ? { ...result, content } : result;
}
