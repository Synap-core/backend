/**
 * ONE log line per MCP `tools/call`: which tool ran, how long it took, how it
 * ended. The request log (`--> POST /mcp 200 14ms`) names the route only, and
 * `POST /mcp` is a pod's largest load (1,699 calls and 561 s of request time an
 * hour on the founder's pod, 2026-11-26) with no way to say which tools cost.
 *
 * The line carries the tool's NAME only, never its arguments or its result:
 * arguments are a person's content (queries, titles, documents). `via` says the
 * tool was run through `synap_call_tool`, whose inner tool is the one named.
 * `ms` is the tools/call handler's own time (the fence, the shadow check and
 * the tool); the HTTP door's auth and server build are in the request log's
 * total for the same request.
 */
import { createLogger } from "@synap-core/core";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { MCP_CALL_REFUSED_CODE } from "./call-fence.js";

const logger = createLogger({ module: "mcp-tool-call" });

/** How a call ended: `tool_error` = the tool answered `isError`. */
export type ToolCallOutcome = "ok" | "tool_error" | "refused" | "error";

/** What the handler fills while it resolves the call (the name it RUNS). */
export interface ToolCallLine {
  tool: string;
  via?: string;
}

/**
 * Wrap a tools/call handler so every call, whatever its end, logs one line.
 * The handler names the tool it actually runs on `line` (after unwrapping
 * `synap_call_tool`); an unwrapped call keeps the requested name.
 */
export function withToolCallLog<
  Req extends { params: { name: string } },
  Extra,
  Res extends { isError?: boolean },
>(
  handler: (request: Req, extra: Extra, line: ToolCallLine) => Promise<Res>,
  fields: { key?: string } = {}
): (request: Req, extra: Extra) => Promise<Res> {
  return async (request, extra) => {
    const line: ToolCallLine = { tool: request.params.name };
    const started = performance.now();
    let outcome: ToolCallOutcome = "error";
    try {
      const result = await handler(request, extra, line);
      outcome = result?.isError ? "tool_error" : "ok";
      return result;
    } catch (err) {
      outcome =
        err instanceof McpError && err.code === MCP_CALL_REFUSED_CODE
          ? "refused"
          : "error";
      throw err;
    } finally {
      logger.info(
        {
          tool: line.tool,
          ...(line.via ? { via: line.via } : {}),
          ...(fields.key ? { key: fields.key } : {}),
          ms: Math.round(performance.now() - started),
          outcome,
        },
        "mcp tool call"
      );
    }
  };
}
