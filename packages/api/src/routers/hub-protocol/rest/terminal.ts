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

    // `since` is interpolated into a shell command below — allow ONLY the two
    // forms docker `--since` accepts (relative duration like "10m"/"2h30m"/"90s"
    // or an RFC3339 timestamp). This rejects any shell metacharacter, so nothing
    // injectable can survive into the exec string.
    if (
      since &&
      !/^(\d+[smhd])+$/.test(since) &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(
        since
      )
    ) {
      return c.json(
        {
          error:
            'Invalid "since": expected a relative duration (e.g. 10m, 2h30m, 3d) or an RFC3339 timestamp.',
        },
        400
      );
    }

    const containerName = ALLOWED_SERVICES[service];

    // Case-insensitive line filter, applied in-process. NEVER shell out the
    // filter: `docker logs ... | grep <filter>` let `$(...)`/backticks in the
    // user-supplied pattern execute on the host.
    const applyFilter = (text: string): string => {
      if (!filter) return text;
      const needle = filter.toLowerCase();
      return text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .join("\n");
    };

    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const runOpts = { timeout: 10_000, maxBuffer: 100 * 1024 } as const;

      // Args are passed as an array (no shell), so `since` and the container
      // name can never be interpreted as shell syntax.
      const dockerArgs = ["logs", `--tail=${lines}`];
      if (since) dockerArgs.push(`--since=${since}`);
      dockerArgs.push(containerName);

      let output: string;
      try {
        const { stdout, stderr } = await execFileAsync(
          "docker",
          dockerArgs,
          runOpts
        );
        output = applyFilter(`${stdout}${stderr}`);
      } catch {
        // Fallback: journalctl (also shell-free)
        const jArgs = [
          "-u",
          `synap-${service}`,
          "-n",
          String(lines),
          "--no-pager",
        ];
        if (since) jArgs.push("--since", `${since} ago`);
        try {
          const { stdout, stderr } = await execFileAsync(
            "journalctl",
            jArgs,
            runOpts
          );
          output = applyFilter(`${stdout}${stderr}`);
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
