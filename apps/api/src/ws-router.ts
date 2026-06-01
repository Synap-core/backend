/**
 * WebSocket Upgrade Router
 *
 * Routes HTTP upgrade requests to the correct WebSocket handler based on path.
 * A single "upgrade" listener is registered on the HTTP server; each handler
 * is responsible only for its own path — unknown paths are destroyed here.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { handleSshUpgrade } from "./ssh-proxy.js";
import { handleRecipeRunUpgrade } from "./recipe-runner.js";
import { handleLocalTerminalUpgrade } from "./local-terminal.js";
import { handleClaudeCodeUpgrade } from "./claude-code.js";

export function handleWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/api/devplane/ssh") {
    handleSshUpgrade(req, socket, head);
  } else if (url.pathname === "/api/devplane/recipe-run") {
    handleRecipeRunUpgrade(req, socket, head);
  } else if (url.pathname === "/api/devplane/local-terminal") {
    handleLocalTerminalUpgrade(req, socket, head);
  } else if (url.pathname === "/api/devplane/claude-code") {
    handleClaudeCodeUpgrade(req, socket, head);
  } else {
    // Unknown upgrade target — destroy so it doesn't hang
    socket.destroy();
  }
}
