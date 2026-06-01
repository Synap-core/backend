/**
 * SSH Terminal Proxy
 *
 * Bridges a WebSocket connection (from DevPlane web app) to an SSH PTY shell
 * on a remote server. SSH credentials are fetched server-side from the Synap
 * Vault so the private key is never exposed to the browser.
 *
 * Wire-up in index.ts via the raw Node.js HTTP "upgrade" event:
 *
 *   const server = serve({ fetch: app.fetch, port, hostname })
 *   server.on("upgrade", handleSshUpgrade)
 *
 * WebSocket URL: ws://host/api/devplane/ssh?envId=<entityId>&ticket=<wsTicket>
 *
 * Messages FROM browser:
 *   - Binary frames         → forwarded as-is to the SSH stream (terminal input)
 *   - Text JSON `{ type: "resize", cols: N, rows: N }` → PTY window resize
 *
 * Messages TO browser:
 *   - Binary frames         → raw SSH stdout/stderr (terminal output)
 *   - Text JSON `{ type: "ready" }` → SSH shell opened
 *   - Text JSON `{ type: "error", message: "..." }` → connection error
 *   - Text JSON `{ type: "closed" }` → remote side closed the shell
 */

import { Client as SshClient, type ClientChannel } from "ssh2";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { db, eq, and } from "@synap/database";
import { entities } from "@synap/database/schema";
import { parseVaultReference, resolveVaultSecret } from "@synap/api";
import { resolveUserId } from "./ws-auth.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "ssh-proxy" });

// Lazy-initialised WebSocket server (no HTTP server attached — we handle
// upgrade manually so Hono keeps full control of the HTTP server).
let wss: WebSocketServer | null = null;

function getWss(): WebSocketServer {
  if (!wss) {
    wss = new WebSocketServer({ noServer: true });
  }
  return wss;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SshSessionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

// ─── Credential resolver ──────────────────────────────────────────────────────

/**
 * Load a devplane_environment entity and resolve its SSH credentials via Vault.
 *
 * Expected entity properties:
 *   envHost          string  — hostname or IP of the remote server
 *   envPort          number  — SSH port (default 22)
 *   sshUser          string  — SSH username
 *   sshKeyVaultRef   string  — vault://secret-uuid reference to the private key
 */
async function resolveEnvironmentCredentials(
  environmentEntityId: string,
  userId: string
): Promise<SshSessionConfig> {
  const entity = await db.query.entities.findFirst({
    where: and(
      eq(entities.id, environmentEntityId),
      eq(entities.userId, userId)
    ),
    columns: { id: true, type: true, properties: true },
  });

  if (!entity) {
    throw new Error(
      `Environment entity not found or access denied: ${environmentEntityId}`
    );
  }

  if (entity.type !== "devplane_environment") {
    throw new Error(
      `Entity ${environmentEntityId} is not a devplane_environment (got: ${entity.type})`
    );
  }

  const props = (entity.properties ?? {}) as Record<string, unknown>;

  const host = props["envHost"] as string | undefined;
  const username = props["sshUser"] as string | undefined;
  const sshKeyVaultRef = props["sshKeyVaultRef"] as string | undefined;
  const port =
    typeof props["envPort"] === "number" ? (props["envPort"] as number) : 22;

  if (!host) throw new Error("Environment entity missing envHost property");
  if (!username) throw new Error("Environment entity missing sshUser property");
  if (!sshKeyVaultRef)
    throw new Error("Environment entity missing sshKeyVaultRef property");

  const ref = parseVaultReference(sshKeyVaultRef);
  if (!ref) {
    throw new Error(`Invalid vault reference: ${sshKeyVaultRef}`);
  }

  const privateKey = await resolveVaultSecret(
    ref.secretId,
    userId,
    ref.fieldName
  );
  if (!privateKey) {
    throw new Error(
      "Could not resolve SSH private key from vault — ensure the secret exists and uses server-side encryption"
    );
  }

  return { host, port, username, privateKey };
}

// ─── Session handler ──────────────────────────────────────────────────────────

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function handleSshSession(
  ws: WebSocket,
  environmentEntityId: string,
  userId: string
): Promise<void> {
  let sshClient: SshClient | null = null;

  try {
    const creds = await resolveEnvironmentCredentials(
      environmentEntityId,
      userId
    );

    sshClient = new SshClient();

    sshClient.on("ready", () => {
      logger.info(
        { envId: environmentEntityId, host: creds.host },
        "SSH connection established"
      );
      sendJson(ws, { type: "ready" });

      sshClient!.shell(
        { term: "xterm-256color", cols: 80, rows: 24 },
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            logger.error({ err }, "SSH shell open failed");
            sendJson(ws, { type: "error", message: err.message });
            ws.close(1011, err.message);
            sshClient?.end();
            return;
          }

          // SSH → browser
          stream.on("data", (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          });
          stream.stderr.on("data", (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          });
          stream.on("close", () => {
            logger.info({ envId: environmentEntityId }, "SSH stream closed");
            sendJson(ws, { type: "closed" });
            ws.close(1000, "SSH session ended");
            sshClient?.end();
          });

          // browser → SSH
          ws.on("message", (data: Buffer | string) => {
            if (stream.writable) {
              if (typeof data === "string") {
                // JSON control messages
                try {
                  const msg = JSON.parse(data) as Record<string, unknown>;
                  if (
                    msg.type === "resize" &&
                    typeof msg.rows === "number" &&
                    typeof msg.cols === "number"
                  ) {
                    stream.setWindow(msg.rows, msg.cols, 0, 0);
                  } else {
                    // Treat unknown text as raw input (e.g. from xterm.js paste)
                    stream.write(data);
                  }
                } catch {
                  stream.write(data);
                }
              } else {
                // Binary terminal input
                stream.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
              }
            }
          });

          ws.on("close", () => {
            stream.close();
            sshClient?.end();
          });
        }
      );
    });

    sshClient.on("error", (err: Error) => {
      logger.error({ err: err.message, host: creds.host }, "SSH client error");
      sendJson(ws, { type: "error", message: err.message });
      ws.close(1011, err.message);
    });

    sshClient.connect({
      host: creds.host,
      port: creds.port,
      username: creds.username,
      privateKey: creds.privateKey,
      readyTimeout: 20_000,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Connection failed";
    logger.error({ error: message }, "SSH session setup failed");
    try {
      sendJson(ws, { type: "error", message });
      ws.close(1011, message);
    } catch {
      // ignore
    }
    sshClient?.end();
  }
}

// ─── Upgrade handler (wired into Node HTTP server) ────────────────────────────

/**
 * Handle HTTP upgrade requests for the SSH WebSocket endpoint.
 *
 * Only handles `GET /api/devplane/ssh` — all other upgrade requests are
 * destroyed so Hono's existing SSE / other WS routes are unaffected.
 */
export function handleSshUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname !== "/api/devplane/ssh") {
    // Not our endpoint — destroy socket so it doesn't hang
    socket.destroy();
    return;
  }

  const envId = url.searchParams.get("envId");
  if (!envId) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Length: 15\r\n\r\nMissing envId"
    );
    socket.destroy();
    return;
  }

  // Authenticate before completing the upgrade
  resolveUserId(req)
    .then((userId) => {
      if (!userId) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized"
        );
        socket.destroy();
        return;
      }

      getWss().handleUpgrade(req, socket, head, (ws: WebSocket) => {
        logger.info({ envId, userId }, "SSH WebSocket upgrade accepted");
        handleSshSession(ws, envId, userId);
      });
    })
    .catch((err) => {
      logger.error({ err }, "SSH upgrade auth error");
      socket.destroy();
    });
}
