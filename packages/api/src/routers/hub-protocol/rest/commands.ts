/**
 * Hub Protocol REST — commands (list/get + secured /commands/execute runner)
 */

import { realpathSync, existsSync } from "fs";
import { resolve as resolvePath } from "path";

import { z } from "@hono/zod-openapi";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { intelligenceCommands, asc, eq } from "@synap/database";

import { AccessContext, scopedDb } from "../../../access/index.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CommandIdParamSchema,
  ExecuteCommandRequestSchema,
  ExecuteCommandResponseSchema,
  ListCommandsQuerySchema,
  WireCommandSchema,
} from "./_codecs/command.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

// ─── Rate limiter for terminal commands ─────────────────────────────────────
const _commandRateLimiter = new Map<
  string,
  { count: number; resetAt: number }
>();

function checkCommandRateLimit(workspaceId: string): boolean {
  const now = Date.now();
  const key = `cmd:${workspaceId}`;
  const entry = _commandRateLimiter.get(key);

  if (!entry || entry.resetAt < now) {
    _commandRateLimiter.set(key, { count: 1, resetAt: now + 60_000 });
    return true; // allowed
  }

  if (entry.count >= 10) {
    return false; // rate limited
  }

  entry.count++;
  return true;
}

/** Commands that are always blocked regardless of permissions */
const BLOCKED_COMMAND_PATTERNS = [
  // Filesystem destruction
  /\brm\s+.*-[a-z]*r[a-z]*f/i, // rm -rf (any flags order)
  /\brm\s+.*\s+\/($|\s)/i, // rm anything at root
  /\brm\s+-[a-z]*r/i, // any recursive rm

  // System control
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\binit\s+[0-6]\b/i,
  /\bsystemctl\s+(halt|poweroff|reboot)\b/i,

  // Disk/device destruction
  /\bmkfs\b/i,
  /\bdd\b.*\bof\s*=\s*\/dev\//i, // dd to block devices
  />\s*\/dev\/sd[a-z]/i, // write to block devices
  />\s*\/dev\/nvme/i,

  // Fork bombs and resource exhaustion
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, // :(){ :|:& };:
  /\bfork\s*bomb/i,
  /while\s+true.*do/i, // while true; do ... (infinite loops)
  /\byes\s*\|/i, // yes | ... (can flood stdin)

  // Remote code execution via pipe
  /\bcurl\b.*\|\s*(bash|sh|zsh|python|perl|ruby)\b/i,
  /\bwget\b.*\|\s*(bash|sh|zsh|python|perl|ruby)\b/i,
  /\bcurl\b.*>\s*[^\s]+\s*&&\s*(bash|sh|chmod)/i, // curl > file && bash/chmod

  // Credential / key theft
  /\bcat\b.*\/(\.ssh|\.gnupg|\.aws\/credentials)/i,
  /\bcp\b.*\/(\.ssh|\.gnupg|\.aws\/credentials)/i,

  // Environment manipulation that could affect the host
  /\bexport\b.*\b(PATH|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/i,
  /\bchmod\s+[0-7]*[2367][0-7]*\s+\//i, // chmod making system files world-writable
  /\bchown\b.*\s+\/($|\s)/i, // chown on root

  // Container/VM escape attempts
  /\bnsenter\b/i,
  /\bdocker\s+run\b.*--privileged/i,
  /\bmount\b.*\/dev\//i,

  // Network exfiltration of system files
  /\b(nc|ncat|netcat)\b.*<\s*\//i, // piping system files to netcat
];

/** Allowlisted environment variables passed to child processes */
const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Node/NPM
  "NODE_ENV",
  "NODE_PATH",
  "NPM_CONFIG_PREFIX",
  // Common dev tools
  "EDITOR",
  "VISUAL",
  "PAGER",
  // Git
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/**
 * Build a sanitized environment for child process execution.
 */
function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}

/**
 * Validate and resolve workingDir to prevent path traversal.
 */
function validateWorkingDir(requestedDir: string | undefined): {
  dir: string;
  error?: string;
} {
  if (!requestedDir) {
    return { dir: process.cwd() };
  }

  // Resolve to absolute path (handles ../ etc.)
  const resolved = resolvePath(requestedDir);

  // Check the directory exists
  if (!existsSync(resolved)) {
    return {
      dir: "",
      error: `Working directory does not exist: ${requestedDir}`,
    };
  }

  // Resolve symlinks to real path
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return {
      dir: "",
      error: `Cannot resolve working directory: ${requestedDir}`,
    };
  }

  // Block access to sensitive system directories
  const BLOCKED_DIRS = [
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/root",
  ];
  for (const blocked of BLOCKED_DIRS) {
    if (realPath === blocked || realPath.startsWith(blocked + "/")) {
      return { dir: "", error: `Access to ${blocked} is not allowed` };
    }
  }

  return { dir: realPath };
}

/**
 * Redact potential secrets from command output.
 */
function redactSecrets(output: string): string {
  return (
    output
      // Generic key=value secrets (KEY=sk-..., TOKEN=abc123...)
      .replace(
        /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|credentials?)\s*[=:]\s*\S+/gi,
        "$1=***REDACTED***"
      )
      // Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi, "Bearer ***REDACTED***")
      // Connection strings with passwords
      .replace(/:\/\/[^:]+:[^@]+@/g, "://***:***@")
      // AWS-style keys
      .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "***REDACTED_AWS_KEY***")
      // Private keys
      .replace(
        /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
        "***REDACTED_PRIVATE_KEY***"
      )
  );
}

export function registerCommandsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/commands",
    tags: ["Commands"],
    summary: "List commands available to the user",
    request: {
      query: ListCommandsQuerySchema,
    },
    responses: {
      200: { description: "Commands", schema: z.array(WireCommandSchema) },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/commands/{id}",
    tags: ["Commands"],
    summary: "Get a single command",
    request: {
      params: CommandIdParamSchema,
    },
    responses: {
      200: { description: "Command", schema: WireCommandSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Command not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/commands/execute",
    tags: ["Commands"],
    summary: "Execute a command (RBAC + proposal flow)",
    description:
      "Runs a shell-compatible command after security gating. Three terminal states: `executed`, `proposed` (awaiting approval), `denied` (blocked by policy). Rate-limited to 10/min per workspace.",
    request: {
      body: ExecuteCommandRequestSchema,
    },
    responses: {
      200: {
        description: "Execution result, proposal, or denial",
        schema: ExecuteCommandResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      429: { description: "Rate limit exceeded", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /commands?workspaceId=...
   */
  app.get("/commands", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId") as string;
    try {
      // Floor through the access layer's sharedScope-aware rule (same rule the
      // tRPC surface uses): workspace-shared commands are visible to workspace
      // members; sharedScope='user' commands ONLY to their creator. The
      // workspace lens narrows within the membership floor — a supplied
      // workspaceId can only NARROW, never widen to a foreign workspace.
      const access = AccessContext.agent({ userId }).withLens(
        workspaceId ?? undefined
      );
      const commands = await scopedDb(access).findMany<
        typeof intelligenceCommands.$inferSelect
      >(intelligenceCommands, {
        orderBy: [asc(intelligenceCommands.createdAt)],
      });
      return c.json(commands);
    } catch (err) {
      logger.error({ err }, "listCommands failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /commands/:id
   */
  app.get("/commands/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    try {
      // Floor through the sharedScope-aware rule: a workspace-shared command is
      // visible to workspace members; a sharedScope='user' command only to its
      // creator. A non-visible id resolves to undefined → 404, so an agent
      // acting for user A can't read user B's private command.
      const access = AccessContext.agent({ userId });
      const command = await scopedDb(access).findFirst<
        typeof intelligenceCommands.$inferSelect
      >(intelligenceCommands, {
        where: eq(intelligenceCommands.id, id),
      });
      if (!command) return c.json({ error: "Not found" }, 404);
      return c.json(command);
    } catch (err) {
      logger.error({ err, id }, "getCommand failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /commands/execute
   */
  app.post("/commands/execute", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    // Rate limit: 10 commands per workspace per minute.
    // Item 3 Part 3: confine a bound service key to its workspace first, so the
    // rate-limit key and the downstream permission check both use the pinned ws.
    const workspaceId =
      getConfinedWorkspace(c, body.workspaceId as string | undefined) ??
      undefined;
    if (workspaceId && !checkCommandRateLimit(workspaceId)) {
      return c.json(
        {
          error:
            "Rate limit exceeded: maximum 10 commands per minute per workspace",
          retryAfter: 60,
        },
        429
      );
    }

    const command = body.command as string;
    const workingDir = (body.workingDir as string) || undefined;
    const timeoutMs = Math.min(Number(body.timeoutMs) || 30_000, 300_000);
    const userId = (body.userId as string) ?? (c.get("userId") as string);
    const agentUserId = body.agentUserId as string | undefined;
    const sourceMessageId = body.sourceMessageId as string | undefined;
    const reason = body.reason as string | undefined;

    if (!command || !userId) {
      return c.json({ error: "command and userId are required" }, 400);
    }

    // Reject commands with shell metacharacters that could bypass checks
    if (/`[^`]*`/.test(command) || /\$\(/.test(command)) {
      logger.warn(
        { command, userId },
        "Blocked command with shell substitution"
      );
      return c.json({
        status: "denied",
        message:
          "Shell substitution (backticks, $()) is not allowed. Run commands directly.",
      });
    }

    // Validate working directory (prevent path traversal)
    const dirResult = validateWorkingDir(workingDir);
    if (dirResult.error) {
      return c.json({ status: "denied", message: dirResult.error }, 400);
    }

    // Hard block dangerous commands
    for (const pattern of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        logger.warn({ command, userId }, "Blocked dangerous command");
        return c.json({
          status: "denied",
          message: "This command is blocked by security policy",
        });
      }
    }

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const { emitSideEffects } = await import("@synap/events");

      // Permission check — goes through proposal system
      const permResult = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId,
        subjectType: "command",
        action: "execute",
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        data: { command, workingDir, reason },
        threadId: undefined,
        reasoning: reason,
        sourceMessageId,
      });

      if ("denied" in permResult && permResult.denied) {
        return c.json({
          status: "denied",
          message: (permResult as { denied: true; reason: string }).reason,
        });
      }

      if ("proposalId" in permResult) {
        return c.json({
          status: "proposed",
          proposalId: permResult.proposalId,
          summary: permResult.summary,
          reasoning: permResult.reasoning,
          reviewPath: permResult.reviewPath,
          reviewUrl: permResult.reviewUrl,
          message: "Command proposed for approval",
        });
      }

      // Granted — execute the command
      const { execFileSync } = await import("child_process");
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      try {
        const result = execFileSync("/bin/sh", ["-c", command], {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          cwd: dirResult.dir,
          encoding: "utf-8",
          env: buildSafeEnv(),
        });
        stdout = String(result ?? "");
      } catch (execErr: unknown) {
        const err = execErr as {
          stdout?: string;
          stderr?: string;
          status?: number;
          message?: string;
        };
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? err.message ?? "";
        exitCode = err.status ?? 1;
      }

      // Truncate output to prevent massive payloads
      const MAX_OUTPUT = 50_000;
      if (stdout.length > MAX_OUTPUT)
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)";
      if (stderr.length > MAX_OUTPUT)
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n... (truncated)";

      // Redact potential secrets from output before returning
      stdout = redactSecrets(stdout);
      stderr = redactSecrets(stderr);

      // Emit side effects — triggers automation chain
      if (workspaceId) {
        void emitSideEffects({
          subjectType: "command",
          action: "execute",
          subjectId: `cmd-${Date.now()}`,
          userId,
          workspaceId,
          data: {
            command,
            workingDir,
            exitCode,
            reason,
            stdoutPreview: stdout.slice(0, 500),
          },
        });
      }

      return c.json({
        status: "executed",
        exitCode,
        stdout,
        stderr,
      });
    } catch (err) {
      logger.error({ err, command }, "commands.execute failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
