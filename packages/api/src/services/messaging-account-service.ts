import { db, eq, and, messagingAccounts } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "messaging-account-service" });

export type MessagingAccountStatus =
  "connected" | "reconnection_required" | "disconnected";

export interface UpsertMessagingAccountInput {
  userId: string;
  provider: string;
  externalId: string;
  displayName: string;
  status: MessagingAccountStatus;
  workspaceId?: string | null;
  /** Provider-specific detail (expo: platform / device label / app version). */
  metadata?: Record<string, unknown>;
}

export const MessagingAccountService = {
  async upsert(input: UpsertMessagingAccountInput): Promise<void> {
    const [row] = await db
      .insert(messagingAccounts)
      .values({
        userId: input.userId,
        provider: input.provider,
        externalId: input.externalId,
        displayName: input.displayName,
        status: input.status,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .onConflictDoUpdate({
        target: [
          messagingAccounts.userId,
          messagingAccounts.provider,
          messagingAccounts.externalId,
        ],
        set: {
          displayName: input.displayName,
          status: input.status,
          // Only overwrite metadata when the caller supplied it — a re-register
          // that omits it must not blank out a device's stored platform label.
          ...(input.metadata ? { metadata: input.metadata } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: messagingAccounts.id });

    await emitSideEffects({
      subjectType: "messaging_account",
      action: "created",
      subjectId: row.id,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      data: {
        provider: input.provider,
        externalId: input.externalId,
        displayName: input.displayName,
        status: input.status,
      },
    }).catch((err) =>
      logger.warn({ err }, "emitSideEffects failed (non-fatal)")
    );
  },

  async updateStatus(
    externalId: string,
    provider: string,
    status: MessagingAccountStatus,
    userId: string,
    workspaceId?: string | null
  ): Promise<void> {
    const [row] = await db
      .update(messagingAccounts)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(messagingAccounts.externalId, externalId),
          eq(messagingAccounts.provider, provider)
        )
      )
      .returning({ id: messagingAccounts.id });

    if (!row) return;

    const action =
      status === "disconnected"
        ? "disconnected"
        : status === "reconnection_required"
          ? "reconnection_required"
          : "updated";

    await emitSideEffects({
      subjectType: "messaging_account",
      action,
      subjectId: row.id,
      userId,
      workspaceId: workspaceId ?? null,
      data: { externalId, provider, status },
    }).catch((err) =>
      logger.warn({ err }, "emitSideEffects failed (non-fatal)")
    );
  },

  /**
   * Owner-floored status flip — the same transition as `updateStatus`, but the
   * WHERE also pins `user_id`, so it can only ever touch the caller's OWN row.
   *
   * `updateStatus` above matches on (externalId, provider) ALONE: it is fed by
   * inbound provider webhooks, where resolving the owner IS the lookup. That
   * shape is wrong for anything driven by a user request or by a push token
   * (which a caller could otherwise guess), so those paths use this door.
   *
   * Returns whether a row was actually touched, so a caller can tell "revoked"
   * from "there was nothing to revoke" instead of reporting a silent success.
   */
  async setStatusForUser(input: {
    userId: string;
    provider: string;
    externalId: string;
    status: MessagingAccountStatus;
    workspaceId?: string | null;
  }): Promise<boolean> {
    const [row] = await db
      .update(messagingAccounts)
      .set({ status: input.status, updatedAt: new Date() })
      .where(
        and(
          eq(messagingAccounts.userId, input.userId),
          eq(messagingAccounts.provider, input.provider),
          eq(messagingAccounts.externalId, input.externalId)
        )
      )
      .returning({ id: messagingAccounts.id });

    if (!row) return false;

    await emitSideEffects({
      subjectType: "messaging_account",
      action:
        input.status === "disconnected"
          ? "disconnected"
          : input.status === "reconnection_required"
            ? "reconnection_required"
            : "updated",
      subjectId: row.id,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      data: {
        externalId: input.externalId,
        provider: input.provider,
        status: input.status,
      },
    }).catch((err) =>
      logger.warn({ err }, "emitSideEffects failed (non-fatal)")
    );

    return true;
  },
};
