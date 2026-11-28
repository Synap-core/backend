/**
 * What the door did to a call's ARGUMENTS, said on the reply (tickets
 * e18a0451, 1ef84d45, 2d61ff7c). MCP input schemas are advisory, so a call
 * could be changed under the caller with nothing said: a `limit` above the
 * tool's page cap was clamped (`list_sessions` with `limit: 100` returned 50
 * rows, as if there were no more). An argument the tool does not take is no
 * longer dropped and noted: it is refused (`parseToolArgs`, `define-tool.ts`).
 *
 * ONE mechanism for every tool: the `tools/call` door (`mcp/index.ts`) opens a
 * scope around the call; the one page clamp (`pageLimit`,
 * `handlers/shared.ts`) notes what it did in it; the door adds the note to the
 * reply's JSON payload as `limitClamped`. A note made outside a scope (a Hub REST
 * or tRPC caller of the same helper) is dropped: that door has its own
 * contract.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseJsonObject } from "./ui-tools.js";

export interface LimitClampedNotice {
  /** The `limit` the caller sent. */
  asked: number;
  /** The page size actually used. */
  used: number;
}

export interface CallNotices {
  limitClamped?: LimitClampedNotice;
}

const sink = new AsyncLocalStorage<CallNotices>();

/** Run one tool call with a notice scope; returns its result and the notes. */
export async function runWithCallNotices<T>(
  fn: () => Promise<T>
): Promise<{ result: T; notices: CallNotices }> {
  const notices: CallNotices = {};
  const result = await sink.run(notices, fn);
  return { result, notices };
}

/** `pageLimit` used another page size than the caller's own `limit`. */
export function noteLimitClamped(asked: number, used: number): void {
  const scope = sink.getStore();
  if (scope) scope.limitClamped = { asked, used };
}

function isEmpty(notices: CallNotices): boolean {
  return !notices.limitClamped;
}

/**
 * The notes, added to the reply's JSON payload (the first text block that
 * parses as an object — what `ok()` emits), else as a JSON block of their
 * own (a plain-text error). A UI tool's `structuredContent` copy gets them
 * too, so the two never diverge. No note: the SAME object back.
 */
export function withCallNotices(
  result: CallToolResult,
  notices: CallNotices
): CallToolResult {
  if (isEmpty(notices)) return result;
  const added: Record<string, unknown> = {
    ...(notices.limitClamped ? { limitClamped: notices.limitClamped } : {}),
  };
  const content = Array.isArray(result.content) ? [...result.content] : [];
  const index = content.findIndex(
    (block) => block.type === "text" && parseJsonObject(block.text) !== null
  );
  if (index === -1) {
    content.push({ type: "text" as const, text: JSON.stringify(added) });
  } else {
    const block = content[index] as { type: "text"; text: string };
    content[index] = {
      ...block,
      text: JSON.stringify({ ...parseJsonObject(block.text)!, ...added }),
    };
  }
  const structured =
    result.structuredContent && typeof result.structuredContent === "object"
      ? { structuredContent: { ...result.structuredContent, ...added } }
      : {};
  return { ...result, content, ...structured };
}
