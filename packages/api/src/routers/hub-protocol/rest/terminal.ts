/**
 * Hub Protocol REST — terminal logs (read-only docker/journalctl)
 */

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  TerminalLogsQuerySchema,
  TerminalLogsResponseSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

export function registerTerminalRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/terminal/logs",
    tags: ["Terminal"],
    summary: "Read pod service logs",
    description:
      "Read-only docker logs / journalctl for an allowlisted set of services (api, intelligence, realtime, postgres, typesense). Auto-approved.",
    request: {
      query: TerminalLogsQuerySchema,
    },
    responses: {
      200: {
        description: "Log output (last N lines)",
        schema: TerminalLogsResponseSchema,
      },
      400: { description: "Unknown service", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /terminal/logs?service=...&lines=...&since=...&filter=...
   * Read pod service logs. Auto-approved (read-only).
   * Allowed services: api, intelligence, realtime, postgres, typesense
   */
  app.get("/terminal/logs", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const service = c.req.query("service") ?? "";
    const lines = Math.min(parseInt(c.req.query("lines") ?? "50", 10), 500);
    const since = c.req.query("since"); // e.g. "1h", "30m"
    const filter = c.req.query("filter"); // grep pattern

    // Allowlist of services AI can read logs from
    const ALLOWED_SERVICES: Record<string, string> = {
      api: "synap-api",
      intelligence: "synap-intelligence",
      realtime: "synap-realtime",
      postgres: "synap-postgres",
      typesense: "synap-typesense",
    };

    if (!service || !ALLOWED_SERVICES[service]) {
      return c.json(
        {
          error: `Unknown service "${service}". Allowed: ${Object.keys(ALLOWED_SERVICES).join(", ")}`,
        },
        400
      );
    }

    const containerName = ALLOWED_SERVICES[service];

    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      // Build docker logs command
      let cmd = `docker logs --tail=${lines}`;
      if (since) cmd += ` --since=${since}`;
      cmd += ` ${containerName} 2>&1`;
      if (filter) cmd += ` | grep -i ${JSON.stringify(filter)}`;

      let output: string;
      try {
        const { stdout } = await execAsync(cmd, {
          timeout: 10_000,
          maxBuffer: 100 * 1024,
        });
        output = stdout;
      } catch {
        // Fallback: journalctl
        let jCmd = `journalctl -u synap-${service} -n ${lines} --no-pager`;
        if (since) jCmd += ` --since="${since} ago"`;
        if (filter) jCmd += ` | grep -i ${JSON.stringify(filter)}`;
        try {
          const { stdout } = await execAsync(jCmd, {
            timeout: 10_000,
            maxBuffer: 100 * 1024,
          });
          output = stdout;
        } catch {
          output = `[No logs available for service "${service}". Docker and journalctl both unavailable.]`;
        }
      }

      // Truncate if over 100KB
      const MAX_OUTPUT = 100 * 1024;
      const truncated = Buffer.byteLength(output) > MAX_OUTPUT;
      if (truncated) {
        output =
          output.slice(-MAX_OUTPUT) + "\n[... truncated to last 100KB ...]";
      }

      return c.json({
        service,
        lines,
        truncated,
        output,
      });
    } catch (err) {
      logger.error({ err, service }, "terminal.logs failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
