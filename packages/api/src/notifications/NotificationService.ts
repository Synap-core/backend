/**
 * NotificationService
 *
 * Central service for creating and delivering notifications.
 *
 * Usage:
 *   await NotificationService.create({
 *     type: 'proposal.created',
 *     workspaceId, userId,
 *     sourceType: 'proposal', sourceId: proposalId,
 *     data: { proposalType: 'entity.create', description: '...' },
 *   });
 *
 * The service:
 * 1. Looks up the NotificationDef from registry
 * 2. Evaluates title/body templates with data
 * 3. Persists to notifications table
 * 4. Emits notification:new via Socket.IO (real-time bell update)
 * 5. Logs errors non-fatally (never throws)
 */

import { db, notifications } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { getNotificationDef } from "./registry.js";
import type {
  NotificationCategory,
  NotificationPriority,
} from "@synap/database";

const logger = createLogger({ module: "notification-service" });

// ---------------------------------------------------------------------------
// Template interpolation — simple {{variable}} replacement
// ---------------------------------------------------------------------------

function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key];
    return value !== undefined && value !== null ? String(value) : "";
  });
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  type: string;
  workspaceId: string;
  userId: string;

  // Source traceability
  sourceType: "proposal" | "connector" | "agent" | "system" | "inbox_item";
  sourceId?: string;
  workspaceUrl?: string;

  // Template data (fills {{variables}} in title/body)
  data: Record<string, unknown>;

  // Override registry defaults (optional)
  groupKey?: string;
  expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// The shape emitted over Socket.IO for the frontend bell
// ---------------------------------------------------------------------------

interface NotificationPayload {
  id: string;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  icon: string | undefined;
  sourceType: string;
  sourceId: string | undefined;
  workspaceUrl: string | undefined;
  actions: unknown;
  status: "unread";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const NotificationService = {
  /**
   * Create a notification, persist it, and emit it over Socket.IO.
   * Non-fatal — logs errors but never throws.
   */
  async create(input: CreateNotificationInput): Promise<string | undefined> {
    const def = getNotificationDef(input.type);
    if (!def) {
      logger.warn({ type: input.type }, "Unknown notification type — skipping");
      return undefined;
    }

    const title = interpolate(def.titleTemplate, input.data);
    const body = interpolate(def.bodyTemplate, input.data);

    // Resolve group key if registry specifies groupBy field
    let groupKey: string | undefined = input.groupKey;
    if (!groupKey && def.groupBy) {
      const groupVal = input.data[def.groupBy];
      if (groupVal) {
        groupKey = `${input.workspaceId}:${input.type}:${groupVal}`;
      }
    }

    try {
      const [row] = await db
        .insert(notifications)
        .values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          type: input.type,
          category: def.category as NotificationCategory,
          priority: def.priority as NotificationPriority,
          title,
          body,
          icon: def.icon ?? undefined,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? undefined,
          workspaceUrl: input.workspaceUrl ?? undefined,
          actions: def.actions ?? [],
          groupKey: groupKey ?? undefined,
          expiresAt: input.expiresAt ?? undefined,
        })
        .returning({ id: notifications.id });

      if (!row) return undefined;

      // Emit real-time event to all workspace members
      const payload: NotificationPayload = {
        id: row.id,
        type: input.type,
        category: def.category,
        priority: def.priority,
        title,
        body,
        icon: def.icon ?? undefined,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? undefined,
        workspaceUrl: input.workspaceUrl ?? undefined,
        actions: def.actions ?? [],
        status: "unread",
        createdAt: new Date().toISOString(),
      };

      // Fire-and-forget — never blocks the caller
      emitChatEvent({
        event: "notification:new",
        data: { notification: payload, userId: input.userId },
        workspaceId: input.workspaceId,
      });

      logger.debug(
        {
          notificationId: row.id,
          type: input.type,
          workspaceId: input.workspaceId,
        },
        "Notification created"
      );

      return row.id;
    } catch (err) {
      // Non-fatal — notifications must never break the main flow
      logger.error(
        { err, type: input.type, workspaceId: input.workspaceId },
        "Failed to create notification (non-fatal)"
      );
      return undefined;
    }
  },

  /**
   * Convenience wrapper for proposal-created notifications.
   * Called from permission-check.ts after every db.insert(proposals).
   */
  async fromProposal(opts: {
    proposalId: string;
    workspaceId: string;
    userId: string; // recipient (workspace members)
    proposalType: string;
    description?: string;
    agentUserId?: string;
    workspaceUrl?: string;
  }): Promise<void> {
    await NotificationService.create({
      type: "proposal.created",
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      sourceType: "proposal",
      sourceId: opts.proposalId,
      workspaceUrl: opts.workspaceUrl,
      data: {
        proposalType: opts.proposalType,
        description: opts.description ?? opts.proposalType,
        agentUserId: opts.agentUserId ?? "",
      },
      groupKey: opts.agentUserId
        ? `${opts.workspaceId}:proposal.created:${opts.agentUserId}`
        : undefined,
    });
  },

  /**
   * Convenience wrapper for connector sync events.
   */
  async fromConnectorSync(opts: {
    workspaceId: string;
    userId: string;
    connectorName: string;
    itemCount?: number;
    success: boolean;
    errorMessage?: string;
  }): Promise<void> {
    if (opts.success) {
      await NotificationService.create({
        type: "connector.sync.complete",
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        sourceType: "connector",
        data: {
          connectorName: opts.connectorName,
          itemCount: opts.itemCount ?? 0,
        },
      });
    } else {
      await NotificationService.create({
        type: "connector.sync.failed",
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        sourceType: "connector",
        data: {
          connectorName: opts.connectorName,
          errorMessage: opts.errorMessage ?? "Unknown error",
        },
      });
    }
  },

  /**
   * Convenience wrapper for skill trigger events.
   */
  async fromSkillTrigger(opts: {
    workspaceId: string;
    userId: string;
    skillName: string;
    description?: string;
  }): Promise<void> {
    await NotificationService.create({
      type: "skill.triggered",
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      sourceType: "agent",
      data: {
        skillName: opts.skillName,
        description: opts.description ?? opts.skillName,
      },
    });
  },
};
