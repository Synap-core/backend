/**
 * @deprecated This module is kept for backward compatibility only.
 * Please use DeliveryService directly from "../services/DeliveryService.js"
 *
 * Previous exports:
 * - postProactiveMessage() → Use DeliveryService.deliverToProactiveFeed()
 * - ProactiveMessageType → Use ProactiveMessageType from DeliveryService
 * - PostProactiveMessageOptions → Use FeedDeliveryOptions from DeliveryService
 * - PostProactiveMessageResult → Use DeliveryResult from DeliveryService
 */

// Re-export all public types and the service from DeliveryService
export { DeliveryService } from "../services/DeliveryService.js";
export type {
  ProactiveMessageType,
  FeedDeliveryOptions,
  DeliveryResult,
  DeliveryRequest,
  DeliveryContent,
  DeliverySurface,
} from "../services/DeliveryService.js";

// Deprecated legacy types - kept for backward compatibility
/** @deprecated Use FeedDeliveryOptions from DeliveryService instead */
export type PostProactiveMessageOptions = {
  userId: string;
  workspaceId: string;
  content: string;
  proactiveType: import("../services/DeliveryService.js").ProactiveMessageType;
  metadata?: Record<string, unknown>;
};

/** @deprecated Use DeliveryResult from DeliveryService instead */
export type PostProactiveMessageResult = {
  posted: boolean;
  messageId?: string;
  reason?: string;
};

/**
 * @deprecated Use DeliveryService.deliverToProactiveFeed() instead
 * This function is kept for backward compatibility and delegates to DeliveryService.
 */
export async function postProactiveMessage(
  options: PostProactiveMessageOptions
): Promise<PostProactiveMessageResult> {
  console.warn(
    "[DEPRECATED] postProactiveMessage() is deprecated. Use DeliveryService.deliverToProactiveFeed() instead"
  );

  const { DeliveryService } = await import("../services/DeliveryService.js");
  const result = await DeliveryService.deliverToProactiveFeed({
    userId: options.userId,
    workspaceId: options.workspaceId,
    content: {
      body: options.content,
      metadata: options.metadata,
    },
    deliveryOptions: {
      proactiveType: options.proactiveType,
      checkPreferences: true,
      deduplicate: true,
      emitEvents: true,
      createNotification: false,
    },
  });

  const feedDelivery = result.deliveries[0];
  return {
    posted: result.success,
    messageId: feedDelivery?.id,
    reason: feedDelivery?.error,
  };
}
