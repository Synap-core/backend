/**
 * `synap_call_tool` — the dispatcher's NAME and how a request is unwrapped to
 * the tool it runs. ONE derivation for every layer that judges a `tools/call`
 * by its tool name:
 *
 *   - the tools/call door (`mcp/index.ts`): the call fence, the undeclared-args
 *     shadow and `tools.execute` run on the INNER tool;
 *   - the Hub request guard (`http-handler.ts`): a dispatched long-poll
 *     (`synap_wait_for_answer`) or model call is exempt from the 30 s timeout
 *     like the direct call;
 *   - the pod-edge rate class (`apps/api` `rate-limit-classes.ts`): a
 *     dispatched read spends the read budget, a dispatched `synap_ask` with an
 *     answer the AI budget, exactly as the direct call does.
 *
 * Unwrapped ONCE: a dispatcher naming itself stays the dispatcher here, and the
 * tools/call door refuses it.
 *
 * ZERO IMPORTS, on purpose: `apps/api` reads this through the
 * `@synap/api/mcp-call-tool` subpath from `rate-limit-classes.ts`, whose header
 * forbids the heavy `@synap/api` graph. Keep it that way.
 */

/** The dispatcher's pod name (`pod__call_tool` on the claude.ai connector). */
export const CALL_TOOL_NAME = "synap_call_tool";

/** A plain JSON object (not null, not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The tool a `tools/call` really runs and its arguments: the inner
 * `{tool, arguments}` of a dispatcher call whose `tool` is a non-empty string,
 * else the call as sent. Inner `arguments` that are absent or not an object
 * read as `{}` (the tools/call door answers those cases itself).
 */
export function effectiveToolCall(
  name: unknown,
  args: unknown
): { name: unknown; args: Record<string, unknown> } {
  const outer = isPlainObject(args) ? args : {};
  if (name !== CALL_TOOL_NAME) return { name, args: outer };
  const inner = outer.tool;
  if (typeof inner !== "string" || !inner.trim()) return { name, args: outer };
  return {
    name: inner.trim(),
    args: isPlainObject(outer.arguments) ? outer.arguments : {},
  };
}
