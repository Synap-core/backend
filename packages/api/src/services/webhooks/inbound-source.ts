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
 * A SOURCE IS A CREDENTIAL, minted only by a PERSON (a fresh-auth door): the
 * sender must hold its secret, and whoever holds it can post events that fire
 * the space's automations with no agent in their causal chain. The secret is
 * shown ONCE: on create, and again only by replacing it
 * (`rotateInboundWebhookSecret`, the old one stops at once).
 *
 * An automation (an agent's, a package install's, a template's) only
 * DECLARES the source it listens to, by name (`triggerConfig.webhookSource.name`):
 * its insert and update doors and the template install BIND to the space's
 * source of that name when it exists (`bindWebhookSourceDeclaration` in
 * @synap/database, which never creates one), and creating the source later
 * binds every automation in the space that declared it
 * (`createInboundWebhookSource`). Either order works; no door but a person's
 * mints the credential.
 *
 * Every door here takes a workspace the caller has already been checked
 * against: the router's doors are POD ADMIN only (creating a source re-binds
 * other members' automations to a secret its creator holds).
 */

import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  drizzleSql,
  isUniqueViolation,
  automations,
  webhookSubscriptions,
  bindWebhookSourceDeclaration,
  findInboundWebhookSourceRow,
  readWebhookSourceDeclaration,
  INBOUND_WEBHOOK_SOURCE_COLUMNS,
  WebhookSourceDeclarationError,
  type InboundWebhookSourceRow,
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

const SOURCE_COLUMNS = INBOUND_WEBHOOK_SOURCE_COLUMNS;

function toSource(row: InboundWebhookSourceRow): InboundWebhookSource {
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
  const row = await findInboundWebhookSourceRow(db, workspaceId, name);
  return row ? toSource(row) : null;
}

/**
 * Create a source in a space (a PERSON's door: the routers guard it with fresh
 * authentication). Returns the secret — the ONLY time it is read back; the
 * caller shows it to the person once. A name the space already uses is a 409
 * naming the holder. Binds the space's automations that declared this name
 * (`boundAutomations`).
 */
export async function createInboundWebhookSource(input: {
  userId: string;
  workspaceId: string;
  name: string;
}): Promise<{
  source: InboundWebhookSource;
  secret: string;
  boundAutomations: number;
}> {
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
    const source = toSource(row!);
    const boundAutomations = await bindDeclaringAutomations(source);
    return { source, secret, boundAutomations };
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

/** A refused declaration as the doors' 400. */
function asBadRequest(err: unknown): never {
  if (err instanceof WebhookSourceDeclarationError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  throw err;
}

/**
 * The declared source of a trigger config (`triggerConfig.webhookSource`), or
 * null; a malformed one is a 400 (`readWebhookSourceDeclaration`).
 */
export function declaredWebhookSource(
  triggerType: string | undefined,
  triggerConfig: Record<string, unknown> | undefined
): { name: string } | null {
  try {
    return readWebhookSourceDeclaration(triggerType, triggerConfig);
  } catch (err) {
    return asBadRequest(err);
  }
}

/**
 * Bind an automation's DECLARED source to this space's source of that name
 * (`bindWebhookSourceDeclaration`, which never creates one): the config with
 * `webhookSubscriptionId` set and the source, or the config as is and
 * `source: null` while the space has none. Called by the automation insert
 * and update doors AFTER governance.
 */
export async function bindDeclaredWebhookSource(input: {
  workspaceId: string | null | undefined;
  triggerType: string | undefined;
  triggerConfig: Record<string, unknown>;
}): Promise<{
  triggerConfig: Record<string, unknown>;
  source: InboundWebhookSource | null;
}> {
  const bound = await bindWebhookSourceDeclaration(db, input).catch(
    asBadRequest
  );
  return {
    triggerConfig: bound.triggerConfig,
    source: bound.source ? toSource(bound.source) : null,
  };
}

/**
 * The other half of the binding: a source a person just created binds every
 * automation of its space that declared its name — installed before the
 * source existed, or bound to a source of that name since deleted (the name
 * is unique per space, so the declaration means THIS source). A derived value
 * of the person's own act, written with a version bump like any
 * definition-affecting change. Returns how many automations it bound.
 */
async function bindDeclaringAutomations(
  source: InboundWebhookSource
): Promise<number> {
  const bound = await db
    .update(automations)
    .set({
      triggerConfig: drizzleSql`${automations.triggerConfig} || jsonb_build_object('webhookSubscriptionId', ${source.id}::text)`,
      version: drizzleSql`${automations.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automations.workspaceId, source.workspaceId),
        eq(automations.triggerType, "webhook"),
        drizzleSql`lower(${automations.triggerConfig}->'webhookSource'->>'name') = lower(${source.name})`
      )
    )
    .returning({ id: automations.id });
  return bound.length;
}
