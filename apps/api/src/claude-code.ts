/**
 * Claude Code Coding-Adjunct Proxy
 *
 * Spawns the workspace's configured AI coding CLI (Claude Code by default) in a
 * PTY on the backend server, seeded with the context of a DevPlane task, and
 * streams its output to the browser. This is the "spawn a coding adjunct on a
 * task" surface — the read-only companion to the interactive local-terminal.
 *
 * The frontend (ClaudeCodeTerminal.tsx) connects READ-ONLY (disableStdin), so
 * this handler streams PTY output → WS and only honours resize/cancel control
 * frames; it never writes browser input to the PTY.
 *
 * SECURITY: Gated by the same `workspace.settings.devplane.localTerminalEnabled`
 * flag as local-terminal — only safe on a trusted local pod, never a cloud pod.
 *
 * WebSocket URL: ws://host/api/devplane/claude-code?taskId=X&ticket=Y
 * (workspaceId is derived from the task entity — the frontend sends only taskId.)
 *
 * Messages FROM browser:
 *   - Text JSON `{ type: "resize", cols, rows }` → PTY resize
 *   - Text JSON `{ type: "cancel" }` → kill PTY + close WS
 *   - Binary frames → IGNORED (read-only)
 *
 * Messages TO browser:
 *   - Binary frames → raw PTY output
 *   - Text JSON `{ type: "ready" }` / `{ type: "error", message }` / `{ type: "closed", exitCode }`
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { db, eq, and } from "@synap/database";
import { workspaces, entities } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  resolveUserId,
  isLocalTerminalEnabled,
  resolveProviderEnv,
  resolveWorkspaceCwd,
} from "./local-terminal.js";

const logger = createLogger({ module: "claude-code-terminal" });

let wss: WebSocketServer | null = null;

function getWss(): WebSocketServer {
  if (!wss) wss = new WebSocketServer({ noServer: true });
  return wss;
}

function sendJson(ws: WebSocket, payload: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Escape a string for safe inclusion inside a single-quoted shell argument. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve the launch command for the task from the workspace's configured AI
 * CLI tool (`devplane.aiTerminal.tool`). Claude Code is seeded with the task as
 * an initial prompt; other tools launch bare and read SYNAP_TASK_* from env.
 */
async function resolveLaunchCommand(
  workspaceId: string,
  instruction: string
): Promise<string> {
  let tool = "claude-code";
  let customCommand = "";
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
    const devplane = (settings["devplane"] ?? {}) as Record<string, unknown>;
    const aiTerminal = (devplane["aiTerminal"] ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof aiTerminal["tool"] === "string") tool = aiTerminal["tool"];
    if (typeof aiTerminal["customCommand"] === "string") {
      customCommand = aiTerminal["customCommand"];
    }
  } catch (err) {
    logger.warn({ err, workspaceId }, "Failed to resolve AI terminal tool");
  }

  const quoted = shellSingleQuote(instruction);
  switch (tool) {
    case "opencode":
      return "opencode";
    case "aider":
      return "aider";
    case "custom":
      return customCommand || "claude " + quoted;
    case "claude-code":
    default:
      return "claude " + quoted;
  }
}

export function handleClaudeCodeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  getWss().handleUpgrade(req, socket as any, head, async (ws) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const taskId = url.searchParams.get("taskId") ?? "";

    // Auth
    const userId = await resolveUserId(req);
    if (!userId) {
      sendJson(ws, { type: "error", message: "Authentication required" });
      ws.close(1008, "Unauthorized");
      return;
    }

    if (!taskId) {
      sendJson(ws, { type: "error", message: "taskId is required" });
      ws.close(1008, "Missing taskId");
      return;
    }

    // Resolve the task entity (and its workspace) — frontend sends only taskId.
    const task = await db.query.entities.findFirst({
      where: and(eq(entities.id, taskId), eq(entities.userId, userId)),
      columns: { title: true, type: true, workspaceId: true },
    });
    if (!task || !task.workspaceId) {
      sendJson(ws, { type: "error", message: "Task not found" });
      ws.close(1008, "Task not found");
      return;
    }
    const workspaceId = task.workspaceId;

    // Feature gate — shared with local-terminal (user-controlled workspace setting)
    const enabled = await isLocalTerminalEnabled(workspaceId, userId);
    if (!enabled) {
      sendJson(ws, {
        type: "error",
        message: "Coding terminal is not enabled for this workspace",
      });
      ws.close(1008, "Terminal disabled");
      return;
    }

    // Vault-backed API keys + working directory + launch command
    const taskTitle = task.title ?? taskId;
    // Replace double-quotes so they don't break the quoted framing in the prompt
    // (this is prompt clarity only — shell safety is handled by shellSingleQuote).
    const promptTitle = taskTitle.replace(/"/g, "'");
    const instruction =
      `Work on this Synap task: "${promptTitle}" (id: ${taskId}, type: ${task.type}). ` +
      `Use the SYNAP_TASK_ID and SYNAP_TASK_TITLE environment variables for reference.`;
    const [providerEnv, cwd, launchCommand] = await Promise.all([
      resolveProviderEnv(workspaceId, userId),
      resolveWorkspaceCwd(workspaceId),
      resolveLaunchCommand(workspaceId, instruction),
    ]);

    // Lazy-import node-pty so the module only loads when needed
    let ptyModule: typeof import("node-pty");
    try {
      ptyModule = await import("node-pty");
    } catch (err) {
      logger.error({ err }, "node-pty not available");
      sendJson(ws, {
        type: "error",
        message: "node-pty not installed on this server",
      });
      ws.close(1011, "node-pty unavailable");
      return;
    }

    const shell = process.env["SHELL"] ?? "/bin/bash";

    let ptyProcess: import("node-pty").IPty;
    try {
      ptyProcess = ptyModule.spawn(shell, [], {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd,
        env: {
          ...process.env,
          ...providerEnv,
          SYNAP_TASK_ID: taskId,
          SYNAP_TASK_TITLE: taskTitle,
        } as Record<string, string>,
      });
    } catch (err) {
      logger.error({ err }, "Failed to spawn coding PTY");
      sendJson(ws, {
        type: "error",
        message: `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`,
      });
      ws.close(1011, "PTY spawn failed");
      return;
    }

    logger.info(
      { userId, workspaceId, taskId, pid: ptyProcess.pid, shell },
      "Claude Code PTY spawned"
    );
    sendJson(ws, { type: "ready", shell, pid: ptyProcess.pid });

    // Auto-run the coding agent against the task (stdin is disabled client-side,
    // so the command is executed here rather than waiting for the user to press Enter).
    const autoRunTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ptyProcess.write(launchCommand + "\r");
      }
    }, 400);

    // PTY stdout → WS (binary, same protocol as local-terminal)
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(data, "utf-8"));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      clearTimeout(autoRunTimer);
      logger.info(
        { userId, pid: ptyProcess.pid, exitCode },
        "Coding PTY exited"
      );
      sendJson(ws, { type: "closed", exitCode });
      ws.close(1000, "PTY exited");
    });

    // WS → PTY: read-only. Only honour resize/cancel control frames; ignore input.
    ws.on("message", (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Buffer.isBuffer(data) || data instanceof Uint8Array) return; // read-only
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          cols?: number;
          rows?: number;
        };
        if (msg.type === "resize" && msg.cols && msg.rows) {
          ptyProcess.resize(msg.cols, msg.rows);
        } else if (msg.type === "cancel") {
          ptyProcess.kill();
          ws.close(1000, "Cancelled by client");
        }
      } catch {
        /* ignore malformed control frames */
      }
    });

    ws.on("close", () => {
      clearTimeout(autoRunTimer);
      try {
        ptyProcess.kill();
      } catch {
        /* already gone */
      }
      logger.info(
        { userId, pid: ptyProcess.pid },
        "WS closed — coding PTY killed"
      );
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Claude Code terminal WS error");
      try {
        ptyProcess.kill();
      } catch {
        /* already gone */
      }
    });
  });
}
