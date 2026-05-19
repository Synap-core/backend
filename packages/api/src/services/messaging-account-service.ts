import { db, eq, and, messagingAccounts } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "messaging-account-service" });

export type MessagingAccountStatus =
  | "connected"
  | "reconnection_required"
  | "disconnected";

export interface UpsertMessagingAccountInput {
  userId: string;
  provider: string;
  externalId: string;
  displayName: string;
  status: MessagingAccountStatus;
  workspaceId?: string | null;
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
};
