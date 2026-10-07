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
  } else {
    // `/api/devplane/claude-code` (the pod-spawned coding-agent viewer) was
    // RETIRED 2026-10-08: Synap never spawns a coding agent itself — an
    // external agent is reached only through its dispatch binding.
    // Unknown upgrade target — destroy so it doesn't hang
    socket.destroy();
  }
}
