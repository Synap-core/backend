/**
 * Process-local cancellation registry for active Pod -> Intelligence Service
 * fetches. Durable `cancel_requested` remains the source of truth; this map
 * supplies the immediate abort in the process currently executing the turn.
 */
const activeTurnControllers = new Map<string, AbortController>();

export function activateChatTurn(turnId: string): AbortController {
  const controller = new AbortController();
  activeTurnControllers.set(turnId, controller);
  return controller;
}

export function completeActiveChatTurn(turnId: string): void {
  activeTurnControllers.delete(turnId);
}

export function abortActiveChatTurn(turnId: string): boolean {
  const controller = activeTurnControllers.get(turnId);
  if (!controller) return false;
  controller.abort();
  return true;
}
