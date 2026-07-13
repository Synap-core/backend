/**
 * In-process observation for the HTTP sender stream.
 *
 * The canonical chat workflow already publishes socket events while it runs.
 * An AsyncLocalStorage scope lets the HTTP/SSE caller observe those same
 * events without adding a second persistence or Intelligence Service path.
 * Socket.IO delivery remains unchanged.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatBroadcastOptions } from "./chat-realtime-broadcast.js";

export type ChatTurnObserver = (event: ChatBroadcastOptions) => void;

const observerStorage = new AsyncLocalStorage<ChatTurnObserver>();

export function runWithChatTurnObserver<T>(
  observer: ChatTurnObserver,
  operation: () => Promise<T>
): Promise<T> {
  return observerStorage.run(observer, operation);
}

/** Called by the normal Socket.IO bridge before it schedules network fanout. */
export function notifyChatTurnObserver(event: ChatBroadcastOptions): void {
  try {
    observerStorage.getStore()?.(event);
  } catch {
    // An HTTP observer is never allowed to affect the canonical chat turn.
  }
}
