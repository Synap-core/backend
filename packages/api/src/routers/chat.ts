/**
 * Chat Router - TEMPORARILY DISABLED
 *
 * This router depends on @synap/domain which has been removed.
 *
 * TODO: Refactor to use repositories directly from @synap/database
 * - conversationRepository.getThreadHistory()
 * - conversationRepository.appendMessage()
 * - etc.
 */

import { router } from "../trpc.js";

export const chatRouter = router({
  // All endpoints temporarily disabled - refactor needed
});
