/**
 * Channels Router - tRPC routes for channels (conversations) with branching
 *
 * Handles:
 * - Channel management (channels table, was chat_threads)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 * - Context tracking via channel_context_items
 *
 * Thin barrel: the router is composed from `./channels/*` modules —
 * helpers/schemas (helpers.ts), the sendMessage pipeline (send-message.ts),
 * and the remaining procedure clusters (crud/messaging/branches/external/
 * feeds/membership.ts). Re-exports the public helpers/schemas that external
 * importers and co-located tests depend on.
 *
 * Property order below is deliberately kept identical to the pre-split
 * router (never re-sorted / re-grouped by cluster) so the generated
 * `channels:` type block in api-types/src/generated.d.ts stays byte-identical.
 */

import { router } from "../trpc.js";
import { sendMessageProcedure } from "./channels/send-message.js";
import { crudProcedures } from "./channels/crud.js";
import { messagingProcedures } from "./channels/messaging.js";
import { branchesProcedures } from "./channels/branches.js";
import { externalProcedures } from "./channels/external.js";
import { feedsProcedures } from "./channels/feeds.js";
import { membershipProcedures } from "./channels/membership.js";

export {
  TurnContextSchema,
  type TurnContext,
  channelSendMessageInputSchema,
  redactTurnContext,
  projectTurnAccessWhere,
  usesInternalSessionBoundary,
  invalidateMcpCache,
} from "./channels/helpers.js";

export const channelsRouter = router({
  resolveOrCreateChannel: crudProcedures.resolveOrCreateChannel,
  createChannel: crudProcedures.createChannel,
  createAgentCollabChannel: crudProcedures.createAgentCollabChannel,
  createAndLinkToSession: crudProcedures.createAndLinkToSession,
  createGroupChannel: crudProcedures.createGroupChannel,
  createDocumentComment: crudProcedures.createDocumentComment,
  createEntityComment: crudProcedures.createEntityComment,
  sendMessage: sendMessageProcedure,
  getMessages: messagingProcedures.getMessages,
  getTimeline: messagingProcedures.getTimeline,
  listChannels: crudProcedures.listChannels,
  openProcessChannel: crudProcedures.openProcessChannel,
  narrate: crudProcedures.narrate,
  startNewPersonalConversation: crudProcedures.startNewPersonalConversation,
  listPersonalConversationHistory:
    crudProcedures.listPersonalConversationHistory,
  reopenPersonalConversation: crudProcedures.reopenPersonalConversation,
  closePersonalConversation: crudProcedures.closePersonalConversation,
  listThreads: crudProcedures.listThreads,
  listFeeds: feedsProcedures.listFeeds,
  listExternalChannels: externalProcedures.listExternalChannels,
  listAgentCollabChannels: crudProcedures.listAgentCollabChannels,
  getOrCreateAgentThread: crudProcedures.getOrCreateAgentThread,
  getOrCreateAgentThreadByType: crudProcedures.getOrCreateAgentThreadByType,
  getOrCreateWorkspaceGroup: crudProcedures.getOrCreateWorkspaceGroup,
  getBranches: branchesProcedures.getBranches,
  getWorkspaceBranchTree: branchesProcedures.getWorkspaceBranchTree,
  mergeBranch: branchesProcedures.mergeBranch,
  getChannel: crudProcedures.getChannel,
  updateChannel: crudProcedures.updateChannel,
  addMcpToChannel: externalProcedures.addMcpToChannel,
  removeMcpFromChannel: externalProcedures.removeMcpFromChannel,
  pruneEmptyBranch: branchesProcedures.pruneEmptyBranch,
  archiveChannel: crudProcedures.archiveChannel,
  getBranchTree: branchesProcedures.getBranchTree,
  getChannelContext: messagingProcedures.getChannelContext,
  addContextItem: messagingProcedures.addContextItem,
  deleteMessagesFrom: messagingProcedures.deleteMessagesFrom,
  removeContextItem: messagingProcedures.removeContextItem,
  createExternalChannel: externalProcedures.createExternalChannel,
  patchMessageMetadata: messagingProcedures.patchMessageMetadata,
  updateMessage: messagingProcedures.updateMessage,
  deleteMessage: messagingProcedures.deleteMessage,
  listPinnedMessages: messagingProcedures.listPinnedMessages,
  searchMessages: messagingProcedures.searchMessages,
  setMessagePinned: messagingProcedures.setMessagePinned,
  setupFeed: feedsProcedures.setupFeed,
  getFeedChannel: feedsProcedures.getFeedChannel,
  addTeammate: membershipProcedures.addTeammate,
  removeTeammate: membershipProcedures.removeTeammate,
  listRoomMembers: membershipProcedures.listRoomMembers,
  toggleReaction: messagingProcedures.toggleReaction,
  getChannelReactions: messagingProcedures.getChannelReactions,
  markChannelRead: messagingProcedures.markChannelRead,
});
