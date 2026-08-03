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

import {
  db,
  notifications,
  notificationPreferences,
  workspaceMembers,
  and,
  eq,
  eventRepository,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { SERVER_CONVERSATION_EVENTS } from "../realtime/socket-events.js";
import { emitSideEffects } from "@synap/events";
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
  workspaceId?: string | null;
  userId: string;

  // Source traceability
  sourceType:
    | "proposal"
    | "connector"
    | "agent"
    | "system"
    | "inbox_item"
    | "proactive_message";
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
    if (!groupKey && def.groupBy && input.workspaceId) {
      const groupVal = input.data[def.groupBy];
      if (groupVal) {
        groupKey = `${input.workspaceId}:${input.type}:${groupVal}`;
      }
    }

    try {
      // ── Routing enforcement ────────────────────────────────────────────
      // Check user preferences: global kill switch, routing rules, quiet hours.
      // routingRules stores category-based rules: { "governance": "mute", "ai": "in_app", ... }
      // If a category is "mute", skip entirely (don't persist, don't emit).
      const prefs = input.workspaceId
        ? await db.query.notificationPreferences.findFirst({
            where: and(
              eq(notificationPreferences.userId, input.userId),
              eq(notificationPreferences.workspaceId, input.workspaceId)
            ),
          })
        : null;

      // Global kill switch — skip everything if notifications are disabled
      if (prefs?.enabled === false) {
        logger.debug(
          { type: input.type, userId: input.userId },
          "Notifications disabled for user — skipping"
        );
        return undefined;
      }

      // Per-category routing rule
      const rules = (prefs?.routingRules ?? {}) as Record<string, string>;
      const categoryRule = rules[def.category] ?? rules[input.type]; // check category first, then specific type
      if (categoryRule === "mute") {
        logger.debug(
          { type: input.type, category: def.category },
          "Notification muted by user preference — skipping"
        );
        return undefined;
      }

      // Quiet hours — suppress real-time emission (still persist to DB for later viewing)
      let suppressRealtime = false;
      if (
        prefs?.quietHoursEnabled &&
        prefs.quietHoursStart &&
        prefs.quietHoursEnd
      ) {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const start = prefs.quietHoursStart;
        const end = prefs.quietHoursEnd;
        // Handle overnight ranges (e.g., 22:00 → 08:00)
        const inQuietHours =
          start <= end
            ? hhmm >= start && hhmm < end
            : hhmm >= start || hhmm < end;
        if (inQuietHours) {
          suppressRealtime = true;
        }
      }

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

      // Write to event log for audit trail + cross-pod sync
      eventRepository
        .append({
          id: randomUUID(),
          version: "v1",
          type: "notification.created",
          subjectType: "notification",
          subjectId: row.id,
          data: {
            notificationId: row.id,
            notificationType: input.type,
            category: def.category,
            workspaceId: input.workspaceId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
          userId: input.userId,
          source: "system",
          timestamp: new Date(),
        })
        .catch(() => {}); // non-blocking, non-fatal

      // Trigger automation side-effects for notification.created event type
      emitSideEffects({
        subjectType: "notification",
        action: "created",
        subjectId: row.id,
        userId: input.userId,
        workspaceId: input.workspaceId ?? undefined,
        data: {
          notificationId: row.id,
          notificationType: input.type,
          category: def.category,
        },
      }).catch(() => {}); // non-blocking, non-fatal

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
      // Skip real-time emission during quiet hours (notification is still persisted above)
      // Skip real-time emission if routing rule is "os" only (no in-app)
      const shouldEmitSocket =
        !suppressRealtime && categoryRule !== "os" && !!input.workspaceId;
      if (shouldEmitSocket) {
        emitChatEvent({
          event: SERVER_CONVERSATION_EVENTS.NOTIFICATION_NEW,
          data: { notification: payload, userId: input.userId },
          workspaceId: input.workspaceId!,
        });
      }

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
   * Fan-out a workspace-scoped alert to EVERY member of `workspaceId` — N
   * per-recipient rows (the ratified fan-out shape). Reuses `create()` per
   * member, so per-user read/ack/snooze state, routing prefs, quiet hours, and
   * socket delivery all work unchanged (no shared-row rework). Per-member
   * best-effort: one member's failure never blocks the rest. `subjectUserId` (in
   * `data`, optional) is the person the alert is ABOUT — never a recipient
   * filter; every member is notified. Returns the created notification ids.
   */
  async createForWorkspace(
    input: Omit<CreateNotificationInput, "userId"> & { workspaceId: string }
  ): Promise<string[]> {
    const members = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.workspaceId, input.workspaceId),
      columns: { userId: true },
    });
    const ids: string[] = [];
    for (const member of members) {
      const id = await NotificationService.create({
        ...input,
        userId: member.userId,
      }).catch((err) => {
        logger.warn(
          { err, userId: member.userId, type: input.type },
          "createForWorkspace: per-member create failed (continuing)"
        );
        return undefined;
      });
      if (id) ids.push(id);
    }
    return ids;
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
