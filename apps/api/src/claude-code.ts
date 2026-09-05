/**
 * Claude Code Coding-Adjunct Proxy
 *
 * Spawns the workspace's configured AI coding CLI (Claude Code by default) in a
 * PTY on the backend server, seeded with the context of a DevPlane task, and
 * streams its output to the browser. This is the "spawn a coding adjunct on a
 * task" surface — the read-only companion to the interactive local-terminal.
 *
 * The PTY itself is spawned by `spawnDevAgent` (dev-agent-spawn.ts) — the ONE
 * spawn door, shared with the `external-agent` playbook executor's dispatch.
 * This file owns only the WS transport + auth.
 *
 * The frontend (ClaudeCodeTerminal.tsx) connects READ-ONLY (disableStdin), so
 * this handler streams PTY output → WS and only honours resize/cancel control
 * frames; it never writes browser input to the PTY.
 *
 * SECURITY: Gated by the same `workspace.settings.devplane.localTerminalEnabled`
 * flag as local-terminal — only safe on a trusted local pod, never a cloud pod.
 *
 * WebSocket URL: ws://host/api/devplane/claude-code?taskId=X&ticket=Y[&sessionId=Z]
 * (workspaceId is derived from the task entity — the frontend sends only taskId.
 * `sessionId`, when present, keys the checkout path so two concurrent sessions
 * in one workspace never share a working tree.)
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
import { entities } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { resolveUserId, isLocalTerminalEnabled } from "./local-terminal.js";
import { spawnDevAgent, type DevAgentProcess } from "./dev-agent-spawn.js";

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

export function handleClaudeCodeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  getWss().handleUpgrade(req, socket as any, head, async (ws) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const taskId = url.searchParams.get("taskId") ?? "";
    const sessionId = url.searchParams.get("sessionId") || null;

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

    const taskTitle = task.title ?? taskId;
    // Replace double-quotes so they don't break the quoted framing in the prompt
    // (this is prompt clarity only — shell safety is handled by shellSingleQuote).
    const promptTitle = taskTitle.replace(/"/g, "'");
    const instruction =
      `Work on this Synap task: "${promptTitle}" (id: ${taskId}, type: ${task.type}). ` +
      `Use the SYNAP_TASK_ID and SYNAP_TASK_TITLE environment variables for reference.`;

    let agent: DevAgentProcess;
    try {
      agent = await spawnDevAgent({
        workspaceId,
        userId,
        sessionId,
        instruction,
        extraEnv: {
          SYNAP_TASK_ID: taskId,
          SYNAP_TASK_TITLE: taskTitle,
          ...(sessionId ? { SYNAP_SESSION_ID: sessionId } : {}),
        },
        // PTY stdout → WS (binary, same protocol as local-terminal)
        onData: (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(Buffer.from(data, "utf-8"));
          }
        },
        onExit: (exitCode) => {
          logger.info({ userId, taskId, exitCode }, "Coding PTY exited");
          sendJson(ws, { type: "closed", exitCode });
          ws.close(1000, "PTY exited");
        },
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
      {
        userId,
        workspaceId,
        taskId,
        sessionId,
        pid: agent.pid,
        cwd: agent.cwd,
      },
      "Claude Code PTY spawned"
    );
    sendJson(ws, { type: "ready", shell: agent.shell, pid: agent.pid });

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
          agent.resize(msg.cols, msg.rows);
        } else if (msg.type === "cancel") {
          agent.kill();
          ws.close(1000, "Cancelled by client");
        }
      } catch {
        /* ignore malformed control frames */
      }
    });

    ws.on("close", () => {
      agent.kill();
      logger.info({ userId, pid: agent.pid }, "WS closed — coding PTY killed");
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Claude Code terminal WS error");
      agent.kill();
    });
  });
}
