/**
 * INBOUND WEBHOOK SOURCES — where an outside service (a GitHub org webhook, a
 * form tool, a CI) posts signed events INTO a space. Founder decisions
 * 2026-10-27 (f6852c36 / 4872b139): GitHub events reach the pod through ONE
 * generic door, and the integration is configuration.
 *
 * A source is a `webhook_subscriptions` row with `direction = 'inbound'`
 * (0362): no url, never delivered to (both outbound producers select
 * `outbound` only), one per (space, name). The outside service posts to
 * `/api/webhooks/inbound/:id` (`routers/webhooks-inbound.ts`), signed
 * `sha256=<hmac>` with the source's secret under `X-Synap-Signature` or
 * `X-Hub-Signature-256`; the door fires the space's automations whose
 * `triggerConfig.webhookSubscriptionId` is the source.
 *
 * THE SECRET is shown ONCE, to a PERSON: on create, and again only by
 * replacing it (`rotateInboundWebhookSecret`, the old one stops at once). The
 * sender must hold it, and whoever holds it can post events that fire the
 * space's automations with no agent in their causal chain — so a source an
 * automation's create or a package install declares (`bindDeclaredWebhookSource`)
 * is created WITHOUT revealing its secret to that caller, which may be an
 * agent. The person reveals it from the pod-admin app.
 *
 * Every door here takes a workspace the caller has already been checked
 * against (a workspace member or a pod admin, the router's procedure).
 */

import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  drizzleSql,
  isUniqueViolation,
  webhookSubscriptions,
} from "@synap/database";

/** The generic inbound door (apps/api mounts `webhooksInboundRouter` at `/api/webhooks`). */
export const INBOUND_WEBHOOK_PATH_PREFIX = "/api/webhooks/inbound/";

/**
 * Where the outside service posts. `url` is null when the pod does not know
 * its own public address (`PUBLIC_URL` unset): the path is still exact, and a
 * guessed host would be a confident wrong answer.
 */
export function inboundWebhookAddress(id: string): {
  path: string;
  url: string | null;
} {
  const path = `${INBOUND_WEBHOOK_PATH_PREFIX}${id}`;
  const origin = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return { path, url: origin ? `${origin}${path}` : null };
}

export interface InboundWebhookSource {
  id: string;
  name: string;
  workspaceId: string;
  active: boolean;
  createdAt: Date;
  lastTriggeredAt: Date | null;
  /** The door's path, always known. */
  inboundPath: string;
  /** The full payload URL, or null when the pod has no `PUBLIC_URL`. */
  inboundUrl: string | null;
}

const SOURCE_COLUMNS = {
  id: webhookSubscriptions.id,
  name: webhookSubscriptions.name,
  workspaceId: webhookSubscriptions.workspaceId,
  active: webhookSubscriptions.active,
  createdAt: webhookSubscriptions.createdAt,
  lastTriggeredAt: webhookSubscriptions.lastTriggeredAt,
};

function toSource(row: {
  id: string;
  name: string;
  workspaceId: string | null;
  active: boolean;
  createdAt: Date;
  lastTriggeredAt: Date | null;
}): InboundWebhookSource {
  const address = inboundWebhookAddress(row.id);
  return {
    id: row.id,
    name: row.name,
    // Every inbound source is created in a space (the doors below require it).
    workspaceId: row.workspaceId as string,
    active: row.active,
    createdAt: row.createdAt,
    lastTriggeredAt: row.lastTriggeredAt,
    inboundPath: address.path,
    inboundUrl: address.url,
  };
}

const newSecret = () => randomBytes(32).toString("hex");

const isInboundIn = (workspaceId: string) =>
  and(
    eq(webhookSubscriptions.workspaceId, workspaceId),
    eq(webhookSubscriptions.direction, "inbound")
  );

/** A space's inbound sources, newest first. Never the secret. */
export async function listInboundWebhookSources(
  workspaceId: string
): Promise<InboundWebhookSource[]> {
  const rows = await db
    .select(SOURCE_COLUMNS)
    .from(webhookSubscriptions)
    .where(isInboundIn(workspaceId))
    .orderBy(drizzleSql`${webhookSubscriptions.createdAt} desc`);
  return rows.map(toSource);
}

/** The space's source with this name (case-insensitive), or null. */
export async function findInboundWebhookSourceByName(
  workspaceId: string,
  name: string
): Promise<InboundWebhookSource | null> {
  const [row] = await db
    .select(SOURCE_COLUMNS)
    .from(webhookSubscriptions)
    .where(
      and(
        isInboundIn(workspaceId),
        drizzleSql`lower(${webhookSubscriptions.name}) = lower(${name.trim()})`
      )
    )
    .limit(1);
  return row ? toSource(row) : null;
}

/**
 * Create a source in a space. Returns the secret — the ONLY time it is read
 * back; the caller shows it to the person once. A name the space already
 * uses is a 409 naming the holder.
 */
export async function createInboundWebhookSource(input: {
  userId: string;
  workspaceId: string;
  name: string;
}): Promise<{ source: InboundWebhookSource; secret: string }> {
  const name = input.name.trim();
  if (!name) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A webhook source needs a name.",
    });
  }
  const secret = newSecret();
  try {
    const [row] = await db
      .insert(webhookSubscriptions)
      .values({
        userId: input.userId,
        workspaceId: input.workspaceId,
        direction: "inbound",
        name,
        url: null,
        eventTypes: [],
        secret,
        active: true,
      })
      .returning(SOURCE_COLUMNS);
    return { source: toSource(row!), secret };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const holder = await findInboundWebhookSourceByName(
      input.workspaceId,
      name
    );
    throw new TRPCError({
      code: "CONFLICT",
      message: `This space already has a webhook source named "${holder?.name ?? name}". Replace its secret instead of creating a second one.`,
    });
  }
}

/**
 * Replace a source's secret and return the new one, ONCE. The old secret
 * stops verifying at once (the door reads the row on every request).
 */
export async function rotateInboundWebhookSecret(input: {
  id: string;
  workspaceId: string;
}): Promise<{ source: InboundWebhookSource; secret: string }> {
  const secret = newSecret();
  const [row] = await db
    .update(webhookSubscriptions)
    .set({ secret })
    .where(
      and(eq(webhookSubscriptions.id, input.id), isInboundIn(input.workspaceId))
    )
    .returning(SOURCE_COLUMNS);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Webhook source not found in this space.",
    });
  }
  return { source: toSource(row), secret };
}

/**
 * What an automation declares when it needs a source:
 * `triggerConfig.webhookSource = { name }` on a `webhook` trigger. A package
 * (a catalog automation) can only name the source — the row id is a pod's
 * own — so the install binds the name to this space's source.
 */
export interface DeclaredWebhookSource {
  name: string;
}

/** The declared source of a trigger config, or null; throws on a malformed one. */
export function declaredWebhookSource(
  triggerType: string | undefined,
  triggerConfig: Record<string, unknown> | undefined
): DeclaredWebhookSource | null {
  const declared = triggerConfig?.webhookSource;
  if (declared === undefined) return null;
  const name =
    declared && typeof declared === "object" && !Array.isArray(declared)
      ? (declared as { name?: unknown }).name
      : undefined;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "triggerConfig.webhookSource must be { name: string } (1-100 characters): the inbound webhook source this automation listens to.",
    });
  }
  if (triggerType !== "webhook") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "triggerConfig.webhookSource is read only by a `webhook` trigger.",
    });
  }
  return { name: name.trim() };
}

/**
 * Bind an automation's DECLARED source (`triggerConfig.webhookSource.name`)
 * to this space's source of that name, creating it when the space has none:
 * returns the trigger config with `webhookSubscriptionId` set to it (the
 * matcher's one binding). A config that declares nothing is returned as is.
 *
 * Called by the automation insert and update doors AFTER governance, so a
 * proposed automation creates nothing until it is approved. The created
 * source's secret is NOT returned (see the file header): the person reveals
 * it from pod-admin. The declaration stays on the config, so a re-install in
 * another pod binds that pod's own source.
 */
export async function bindDeclaredWebhookSource(input: {
  userId: string;
  workspaceId: string | null | undefined;
  triggerType: string | undefined;
  triggerConfig: Record<string, unknown>;
}): Promise<{
  triggerConfig: Record<string, unknown>;
  source: (InboundWebhookSource & { created: boolean }) | null;
}> {
  const declared = declaredWebhookSource(
    input.triggerType,
    input.triggerConfig
  );
  if (!declared) return { triggerConfig: input.triggerConfig, source: null };
  if (!input.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `An automation listening to the webhook source "${declared.name}" needs a space: a source belongs to one space (give the automation a workspaceId).`,
    });
  }
  const bind = (source: InboundWebhookSource, created: boolean) => ({
    triggerConfig: {
      ...input.triggerConfig,
      webhookSubscriptionId: source.id,
    },
    source: { ...source, created },
  });
  const existing = await findInboundWebhookSourceByName(
    input.workspaceId,
    declared.name
  );
  if (existing) return bind(existing, false);
  try {
    const { source } = await createInboundWebhookSource({
      userId: input.userId,
      workspaceId: input.workspaceId,
      name: declared.name,
    });
    return bind(source, true);
  } catch (err) {
    // A concurrent install created it between the read and the insert.
    if (!(err instanceof TRPCError) || err.code !== "CONFLICT") throw err;
    const winner = await findInboundWebhookSourceByName(
      input.workspaceId,
      declared.name
    );
    if (!winner) throw err;
    return bind(winner, false);
  }
}
