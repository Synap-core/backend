/**
 * Local Terminal Proxy
 *
 * Spawns a PTY on the backend server machine and proxies it over WebSocket.
 * Intended for DevPlane's "Open in Terminal" feature — lets users run AI CLIs
 * (Claude Code, OpenCode, Aider…) from the browser with a pre-typed command.
 *
 * SECURITY: the shell runs as the API's uid on the pod host, so it holds the
 * whole pod (the API process env, Kratos admin, Postgres). Three checks run
 * BEFORE the upgrade is accepted, so a refused caller never gets a socket:
 *   1. the pod-level operator switch (`isLocalShellAllowed`: LOCAL_MODE or
 *      SYNAP_LOCAL_TERMINAL=1; never on for a cloud pod). Off → 404, and
 *      `ws-router.ts` does not route the path at all;
 *   2. a signed-in caller (single-use ticket);
 *   3. the caller is a pod admin AND owns the workspace named in the URL (its
 *      vault provider keys and dev cwd are what the shell gets).
 * It used to be gated only by `workspace.settings.devplane.localTerminalEnabled`,
 * a setting any member could write on a workspace they created (pre-launch
 * audit 2026-10-28, F2). That setting gates nothing now and
 * `workspaces.update` strips it.
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
import {
  isLocalShellAllowed,
  isPodAdmin,
  resolveVaultSecret,
} from "@synap/api";
import { resolveDevCwd } from "./dev-cwd.js";
import { sanitizePresetCommand, spawnPodPty, type PodPty } from "./pod-pty.js";
// Shared cookie-free WS resolver.
import { resolveUserId } from "./ws-auth.js";

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

/** The workspace the shell is scoped to must be the caller's own. */
export async function ownsWorkspace(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)),
    columns: { id: true },
  });
  return workspace !== undefined;
}

/** Refuse the upgrade with a plain HTTP status: no socket is ever opened. */
function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
  }
  socket.destroy();
}

/**
 * Every check that decides whether this caller may have a shell, run before
 * the WebSocket handshake completes. Returns the caller and workspace, or
 * null after refusing the socket. A failed membership read refuses (503); it
 * never reads as allowed.
 */
async function authorizeLocalTerminal(
  req: IncomingMessage,
  socket: Duplex
): Promise<{ userId: string; workspaceId: string } | null> {
  if (!isLocalShellAllowed()) {
    refuseUpgrade(socket, 404, "Not Found");
    return null;
  }
  const userId = await resolveUserId(req);
  if (!userId) {
    refuseUpgrade(socket, 401, "Unauthorized");
    return null;
  }
  const url = new URL(req.url ?? "", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) {
    refuseUpgrade(socket, 400, "Bad Request");
    return null;
  }
  try {
    if (
      !(await isPodAdmin(userId)) ||
      !(await ownsWorkspace(workspaceId, userId))
    ) {
      logger.warn(
        { userId, workspaceId },
        "Local terminal refused: not a pod admin owning the workspace"
      );
      refuseUpgrade(socket, 403, "Forbidden");
      return null;
    }
  } catch (err) {
    logger.error(
      { err, userId, workspaceId },
      "Local terminal authorization read failed"
    );
    refuseUpgrade(socket, 503, "Service Unavailable");
    return null;
  }
  return { userId, workspaceId };
}

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

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
  authorizeLocalTerminal(req, socket)
    .then((caller) => {
      if (!caller) return;
      getWss().handleUpgrade(req, socket as any, head, (ws) => {
        void runLocalTerminal(req, ws, caller.userId, caller.workspaceId);
      });
    })
    .catch((err: unknown) => {
      logger.error({ err }, "Local terminal authorization failed");
      refuseUpgrade(socket, 503, "Service Unavailable");
    });
}

async function runLocalTerminal(
  req: IncomingMessage,
  ws: WebSocket,
  userId: string,
  workspaceId: string
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  // Pre-typed for the user to review — never allowed to submit itself.
  const presetCmd = sanitizePresetCommand(url.searchParams.get("cmd") ?? "");

  // Resolve AI provider env vars from workspace settings (vault-backed API keys)
  const providerEnv = await resolveProviderEnv(workspaceId, userId);

  // Resolve the working directory (configured monorepo root, fallback $HOME).
  // No session here — the interactive terminal is not session-bound.
  const cwd = await resolveDevCwd(workspaceId);

  let ptyProcess: PodPty["pty"];
  let shell: string;
  try {
    ({ pty: ptyProcess, shell } = await spawnPodPty({
      cwd,
      extraEnv: providerEnv,
    }));
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
}
