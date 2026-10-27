/**
 * An automation's DECLARED inbound webhook source (0362):
 * `triggerConfig.webhookSource = { name }` on a `webhook` trigger. A package
 * (a catalog automation, a workspace template) can only NAME the source — the
 * row id is one pod's own — so every door that writes an automation binds the
 * name to the space's source of that name, and never creates one: a source is
 * a credential only a person mints (api `services/webhooks/inbound-source.ts`,
 * which also binds the other way when a person creates the source later).
 *
 * The ONE reading of the declaration and the ONE binder, shared by the API's
 * automation insert and update doors and the template install
 * (`reconcile-workspace-from-definition.ts`), so "either order works" holds
 * for every way an automation lands.
 */

import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { webhookSubscriptions } from "../schema/webhook_subscriptions.js";

type DbHandle = typeof import("../client-pg.js").db;

/** A declaration the doors refuse; the API maps it to a 400. */
export class WebhookSourceDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSourceDeclarationError";
  }
}

/** The columns a source is read with (never the secret). */
export const INBOUND_WEBHOOK_SOURCE_COLUMNS = {
  id: webhookSubscriptions.id,
  name: webhookSubscriptions.name,
  workspaceId: webhookSubscriptions.workspaceId,
  active: webhookSubscriptions.active,
  createdAt: webhookSubscriptions.createdAt,
  lastTriggeredAt: webhookSubscriptions.lastTriggeredAt,
};

export interface InboundWebhookSourceRow {
  id: string;
  name: string;
  workspaceId: string | null;
  active: boolean;
  createdAt: Date;
  lastTriggeredAt: Date | null;
}

/**
 * The declared source of a trigger config, or null when it declares none.
 * Throws {@link WebhookSourceDeclarationError} on a malformed declaration.
 */
export function readWebhookSourceDeclaration(
  triggerType: string | undefined,
  triggerConfig: Record<string, unknown> | undefined
): { name: string } | null {
  const declared = triggerConfig?.webhookSource;
  if (declared === undefined) return null;
  const name =
    declared && typeof declared === "object" && !Array.isArray(declared)
      ? (declared as { name?: unknown }).name
      : undefined;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    throw new WebhookSourceDeclarationError(
      "triggerConfig.webhookSource must be { name: string } (1-100 characters): the inbound webhook source this automation listens to."
    );
  }
  if (triggerType !== "webhook") {
    throw new WebhookSourceDeclarationError(
      "triggerConfig.webhookSource is read only by a `webhook` trigger."
    );
  }
  return { name: name.trim() };
}

/** The space's inbound source with this name (case-insensitive), or null. */
export async function findInboundWebhookSourceRow(
  conn: DbHandle,
  workspaceId: string,
  name: string
): Promise<InboundWebhookSourceRow | null> {
  const [row] = await conn
    .select(INBOUND_WEBHOOK_SOURCE_COLUMNS)
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.workspaceId, workspaceId),
        eq(webhookSubscriptions.direction, "inbound"),
        drizzleSql`lower(${webhookSubscriptions.name}) = lower(${name.trim()})`
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Bind a trigger config's DECLARED source to this space's source of that
 * name: the config with `webhookSubscriptionId` set to it (the matcher's one
 * binding) and the source, or the config as is and `source: null` when the
 * space has no such source yet (a person creating it binds the automation
 * then). A config that declares nothing is returned as is. Reads only; call
 * it AFTER governance. The declaration stays on the config, so a re-install
 * in another pod binds that pod's own source.
 */
export async function bindWebhookSourceDeclaration(
  conn: DbHandle,
  input: {
    workspaceId: string | null | undefined;
    triggerType: string | undefined;
    triggerConfig: Record<string, unknown>;
  }
): Promise<{
  triggerConfig: Record<string, unknown>;
  source: InboundWebhookSourceRow | null;
}> {
  const declared = readWebhookSourceDeclaration(
    input.triggerType,
    input.triggerConfig
  );
  if (!declared) return { triggerConfig: input.triggerConfig, source: null };
  if (!input.workspaceId) {
    throw new WebhookSourceDeclarationError(
      `An automation listening to the webhook source "${declared.name}" needs a space: a source belongs to one space (give the automation a workspaceId).`
    );
  }
  const source = await findInboundWebhookSourceRow(
    conn,
    input.workspaceId,
    declared.name
  );
  if (!source) return { triggerConfig: input.triggerConfig, source: null };
  return {
    triggerConfig: { ...input.triggerConfig, webhookSubscriptionId: source.id },
    source,
  };
}
