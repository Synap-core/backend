/**
 * Library keep-alive — the daily pass that keeps a Library from becoming a
 * pile without ever becoming an inbox (CAPTURE_LIBRARY_PLAN L5): quiet
 * auto-archive of items unseen for N days, the weekly "Build one group"
 * suggestion, and "From your Library, for <project>" resurfacing.
 *
 * A handler SLOT filled by the api layer at boot (the one-way `api → jobs`
 * dependency: the pass writes notifications through `NotificationService`,
 * which lives in api — same IoC as `library-light-read-worker.ts`).
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "library-keep-alive-worker" });

export const LIBRARY_KEEP_ALIVE_QUEUE = "library-keep-alive";
/** Daily at 04:23 UTC (off the :00 / 03:xx hygiene window). */
export const LIBRARY_KEEP_ALIVE_CRON = "23 4 * * *";

export interface LibraryKeepAliveJobResult {
  archived: number;
  suggested: number;
  resurfaced: number;
}

type KeepAliveHandler = () => Promise<LibraryKeepAliveJobResult>;

let keepAliveHandler: KeepAliveHandler | null = null;

export function registerLibraryKeepAliveHandler(fn: KeepAliveHandler): void {
  keepAliveHandler = fn;
}

export async function handleLibraryKeepAlive(): Promise<LibraryKeepAliveJobResult> {
  if (!keepAliveHandler) {
    // Boot order: the cron can fire before the api filled the slot. Nothing
    // is lost — tomorrow's pass sees the same items and groups.
    logger.warn("library-keep-alive handler not registered yet — skipped");
    return { archived: 0, suggested: 0, resurfaced: 0 };
  }
  return keepAliveHandler();
}
