/**
 * Local Terminal Proxy
 *
 * Spawns a PTY on the backend server machine and proxies it over WebSocket.
 * Intended for DevPlane's "Open in Terminal" feature — lets users run AI CLIs
 * (Claude Code, OpenCode, Aider…) from the browser with a pre-typed command.
 *
 * SECURITY: Enabled per-workspace via `workspace.settings.devplane.localTerminalEnabled`.
 * Only safe when the pod is running on a trusted local machine. Never expose on a cloud pod.
 *
 * WebSocket URL: ws://host/api/devplane/local-terminal?ticket=X&workspaceId=Y&cmd=Z
 *
 * Messages FROM browser:
 *   - Binary frames  → terminal input (written to PTY stdin as UTF-8)
 *   - Text JSON `{ type: "resize", cols: N, rows: N }` → PTY resize
 *   - Text JSON `{ type: "cancel" }` → kill PTY + close WS
 *
 * Messages TO browser:
 *   - Binary frames  → raw PTY output (terminal bytes)
 *   - Text JSON `{ type: "ready", shell: "/bin/zsh" }` → PTY spawned
 *   - Text JSON `{ type: "error", message: "..." }` → error
 *   - Text JSON `{ type: "closed", exitCode: N }` → PTY exited
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { db, eq, and } from "@synap/database";
import { workspaces } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { resolveVaultSecret } from "@synap/api";
// Shared cookie-free WS resolver; re-exported for claude-code.ts.
import { resolveUserId } from "./ws-auth.js";
export { resolveUserId };

const logger = createLogger({ module: "local-terminal" });

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

export async function isLocalTerminalEnabled(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)),
    columns: { settings: true },
  });

  return (workspace?.settings as any)?.devplane?.localTerminalEnabled === true;
}

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Resolve the working directory for a terminal session from workspace settings.
 * Uses `devplane.workspacePath` when configured (the local monorepo root the
 * user set in /providers), falling back to $HOME. Shared by local-terminal and
 * the claude-code coding-adjunct so both spawn in the right project directory.
 */
export async function resolveWorkspaceCwd(
  workspaceId: string
): Promise<string> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
    const devplane = (settings["devplane"] ?? {}) as Record<string, unknown>;
    const workspacePath = devplane["workspacePath"];
    if (typeof workspacePath === "string" && workspacePath.trim().length > 0) {
      return workspacePath;
    }
  } catch (err) {
    logger.warn({ err, workspaceId }, "Failed to resolve workspace cwd");
  }
  return process.env["HOME"] ?? "/";
}

export async function resolveProviderEnv(
  workspaceId: string,
  userId: string
): Promise<Record<string, string>> {
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });

    const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
    const devplane = (settings["devplane"] ?? {}) as Record<string, unknown>;
    // Per-user providers — each workspace member has independent API keys
    const userProviders = (devplane["userProviders"] ?? {}) as Record<
      string,
      Record<string, { apiKeyVaultRef?: string }>
    >;
    const myProviders = (userProviders[userId] ?? {}) as Record<
      string,
      { apiKeyVaultRef?: string }
    >;

    const env: Record<string, string> = {};

    for (const [providerType, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
      const vaultRef = myProviders[providerType]?.apiKeyVaultRef;
      if (vaultRef && /^vault:\/\//.test(vaultRef)) {
        const secretId = vaultRef.replace("vault://", "");
        const apiKey = await resolveVaultSecret(secretId, userId);
        if (apiKey) {
          env[envVar] = apiKey;
        }
      }
    }

    return env;
  } catch (err) {
    logger.warn({ err, workspaceId }, "Failed to resolve provider env vars");
    return {};
  }
}

export function handleLocalTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  getWss().handleUpgrade(req, socket as any, head, async (ws) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const presetCmd = url.searchParams.get("cmd") ?? "";
    const workspaceId = url.searchParams.get("workspaceId") ?? "";

    // Auth
    const userId = await resolveUserId(req);
    if (!userId) {
      sendJson(ws, { type: "error", message: "Authentication required" });
      ws.close(1008, "Unauthorized");
      return;
    }

    // Feature gate — checked from workspace settings (user-controlled, no server restart needed)
    if (!workspaceId) {
      sendJson(ws, { type: "error", message: "workspaceId is required" });
      ws.close(1008, "Missing workspaceId");
      return;
    }

    const enabled = await isLocalTerminalEnabled(workspaceId, userId);
    if (!enabled) {
      sendJson(ws, {
        type: "disabled",
        message: "Local terminal is not enabled for this workspace",
      });
      ws.close(1008, "Local terminal disabled");
      return;
    }

    // Resolve AI provider env vars from workspace settings (vault-backed API keys)
    const providerEnv = await resolveProviderEnv(workspaceId, userId);

    // Resolve the working directory (configured monorepo root, fallback $HOME)
    const cwd = await resolveWorkspaceCwd(workspaceId);

    // Lazy-import node-pty so the module only loads when needed
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
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

    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    let ptyProcess: import("node-pty").IPty;
    try {
      ptyProcess = ptyModule.spawn(shell, [], {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd,
        env: { ...process.env, ...providerEnv } as Record<string, string>,
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to spawn PTY");
      sendJson(ws, {
        type: "error",
        message: `Failed to spawn terminal: ${err.message}`,
      });
      ws.close(1011, "PTY spawn failed");
      return;
    }

    logger.info(
      { userId, workspaceId, pid: ptyProcess.pid, shell },
      "Local PTY spawned"
    );
    sendJson(ws, { type: "ready", shell, pid: ptyProcess.pid });

    // Pre-type the command (no newline — user reviews before pressing Enter)
    if (presetCmd) {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ptyProcess.write(presetCmd);
        }
      }, 400);
    }

    // PTY stdout → WS (binary, same protocol as ssh-proxy)
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(data, "utf-8"));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      logger.info({ userId, pid: ptyProcess.pid, exitCode }, "PTY exited");
      sendJson(ws, { type: "closed", exitCode });
      ws.close(1000, "PTY exited");
    });

    // WS → PTY stdin
    ws.on("message", (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
        ptyProcess.write(Buffer.from(data).toString("utf-8"));
        return;
      }

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
        ptyProcess.write(data.toString());
      }
    });

    ws.on("close", () => {
      try {
        ptyProcess.kill();
      } catch {
        /* already gone */
      }
      logger.info({ userId, pid: ptyProcess.pid }, "WS closed — PTY killed");
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Local terminal WS error");
      try {
        ptyProcess.kill();
      } catch {
        /* already gone */
      }
    });
  });
}
