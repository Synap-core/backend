/**
 * THE reply cap: one door, every MCP tool reply.
 *
 * WHY: no tool reply had a ceiling, so one read could cost tens of thousands
 * of tokens (`synap_get_session` measured 120,612 chars, finding 3a849acf), and
 * Claude Code silently drops the end of anything over its own limit. A reply
 * over the budget now comes back as a valid JSON envelope that SAYS what was
 * left out and how to narrow the call, never silently cut.
 *
 * A reply within budget is returned untouched (the same object). Errors are
 * never capped: an error text must reach the caller whole.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Characters (not tokens) one text block may carry, ~4K tokens. */
export const REPLY_CAP_CHARS = 16_000;

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
  synap_list_tracks: "Lower `limit` and page with `offset`.",
  synap_list_agents: "Lower `limit` and page with `offset`.",
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
