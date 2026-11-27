/**
 * The ONE door that mints the token of a token-in-path inbound webhook
 * (`POST /api/webhooks/<provider>/:token`) and hands back the full URL.
 *
 * Before it, no code wrote `metadata.<provider>.webhook.token`: the templates
 * said "provisioned at install time" and the only writer was `tools.update`,
 * which REPLACES metadata wholesale. Every caller goes through here — the tRPC
 * `tools.provisionWebhook` (apps), Hub REST `POST /tools/:id/webhook` (Eve,
 * CLI, IS) and the capability install (`applyCapabilityDefinition`).
 *
 * - The provider is derived from the tool row's NAME through
 *   `INBOUND_WEBHOOK_PROVIDERS` (the name the route resolves), never passed in,
 *   so the caller cannot mint a token the route will never read.
 * - Authorization: the row must be visible to the caller (else 404, existence
 *   is not leaked), then `assertWorkspaceWrite` on the LOADED row (editor+ of
 *   its workspace, or the owner of a pod-wide row). Same floor as the
 *   config-only `tools.update`; like it, no proposal.
 * - Idempotent: an existing token is returned unchanged unless `rotate`.
 * - Merge, never clobber: only `metadata[key].webhook.token` changes; every
 *   other metadata key and webhook field (secretVaultRef, seen, …) survives.
 *   Read and written under a row lock, so two concurrent first mints converge
 *   on one token.
 * - The token (32 random bytes, base64url) is returned to this caller only. It
 *   is never logged, and the audit row records the provider, not the token.
 * - `signingSecret` (the secret the provider signs its deliveries with, e.g.
 *   Cal.com's webhook secret): for a provider whose route verifies one
 *   (`INBOUND_WEBHOOK_PROVIDERS[...].signingSecret`), it is encrypted into the
 *   vault and `webhook.secretVaultRef` is MERGED in, under the same row lock
 *   — before this door nothing wrote that key, so a Cal.com or Mailgun webhook
 *   could never be accepted. The route redeems the secret as the webhook's
 *   person (`webhook.ownerUserId`, else the tool's creator), so only that
 *   person may set it, into their own vault. Setting it again rewrites the
 *   same vault row. It is never logged, returned, or put in the audit row.
 */
import { randomBytes, randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  eq,
  isNull,
  encryptServerSide,
  isServerVaultAvailable,
  parseVaultReference,
} from "@synap/database";
import { tools, secrets } from "@synap/database/schema";
import { makeVaultReference } from "@synap-core/types/vault";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { podPublicOrigin } from "../../utils/deep-links.js";
import { auditLog } from "../../utils/audit-log.js";
import { isFormToolMetadata } from "../forms/form-definition.js";
import {
  INBOUND_WEBHOOK_PROVIDERS,
  inboundWebhookProviderForTool,
  type InboundWebhookProvider,
} from "./inbound-webhook-providers.js";

export interface ProvisionInboundWebhookInput {
  userId: string;
  toolId: string;
  /** Replace an existing token. The old URL stops working at once. */
  rotate?: boolean;
  /**
   * The provider's webhook signing secret, given by a person. Stored in the
   * vault; only its reference lands on the tool. Never echoed back.
   */
  signingSecret?: string;
}

export interface ProvisionedInboundWebhook {
  provider: InboundWebhookProvider;
  /** `<PUBLIC_URL origin>/api/webhooks/<provider>/<token>`. */
  url: string;
  /** True when an existing token was replaced. */
  rotated: boolean;
  /** Keys the route still needs before it accepts a delivery. */
  missingConfig: string[];
  /** True when this call stored a signing secret (never the secret itself). */
  signingSecretSet?: true;
  /** The manual step on the provider's side, or null when unchecked. */
  setupStep: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function provisionInboundWebhook(
  input: ProvisionInboundWebhookInput
): Promise<ProvisionedInboundWebhook> {
  const origin = podPublicOrigin();
  if (!origin) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This pod has no PUBLIC_URL, so it has no address a webhook can be sent to. Set PUBLIC_URL and try again.",
    });
  }

  const tool = await db.query.tools.findFirst({
    where: and(
      eq(tools.id, input.toolId),
      userVisibleWhere(tools.workspaceId, input.userId)
    ),
    columns: {
      id: true,
      name: true,
      workspaceId: true,
      createdBy: true,
      metadata: true,
    },
  });
  if (!tool) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Tool ${input.toolId} not found`,
    });
  }
  if (isFormToolMetadata(tool.metadata)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This tool is a public form. Manage it through the forms door (forms.*), not the generic tool doors.",
    });
  }
  const provider = inboundWebhookProviderForTool(tool.name);
  if (!provider) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Tool "${tool.name}" does not receive webhooks.`,
    });
  }
  await assertWorkspaceWrite(db, input.userId, {
    workspaceId: tool.workspaceId,
    ownerId: tool.createdBy,
  });

  const spec = INBOUND_WEBHOOK_PROVIDERS[provider];
  const signingSecret = input.signingSecret?.trim() || undefined;
  if (input.signingSecret !== undefined && !signingSecret) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The signing secret is empty.",
    });
  }
  if (signingSecret && spec.signingSecret === "none") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The ${provider} webhook is not signed with a secret, so there is none to set.`,
    });
  }
  if (signingSecret && !isServerVaultAvailable()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This pod's vault has no server key, so it cannot keep a signing secret. Set VAULT_SERVER_KEY and try again.",
    });
  }

  const minted = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: tools.metadata })
      .from(tools)
      .where(eq(tools.id, tool.id))
      .for("update")
      .limit(1);
    if (!locked) return null;
    const metadata = asRecord(locked.metadata);
    const domain = asRecord(metadata[spec.metadataKey]);
    const webhook = asRecord(domain.webhook);
    const current =
      typeof webhook.token === "string" && webhook.token.length > 0
        ? webhook.token
        : null;
    const secretVaultRef = signingSecret
      ? await storeSigningSecret(tx, {
          userId: input.userId,
          webhookOwnerId:
            typeof webhook.ownerUserId === "string" && webhook.ownerUserId
              ? webhook.ownerUserId
              : tool.createdBy,
          toolId: tool.id,
          workspaceId: tool.workspaceId,
          provider,
          signingSecret,
          currentRef:
            typeof webhook.secretVaultRef === "string"
              ? webhook.secretVaultRef
              : null,
        })
      : null;
    if (current && !input.rotate && !secretVaultRef) {
      return { token: current, rotated: false, wrote: false, webhook };
    }
    const token =
      current && !input.rotate
        ? current
        : randomBytes(32).toString("base64url");
    const next: Record<string, unknown> = {
      ...webhook,
      token,
      ...(secretVaultRef ? { secretVaultRef } : {}),
    };
    await tx
      .update(tools)
      .set({
        metadata: {
          ...metadata,
          [spec.metadataKey]: { ...domain, webhook: next },
        },
        updatedAt: new Date(),
      })
      .where(eq(tools.id, tool.id));
    return {
      token,
      rotated: current !== null && token !== current,
      wrote: true,
      webhook: next,
    };
  });
  if (!minted) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Tool ${input.toolId} not found`,
    });
  }

  if (minted.wrote) {
    void auditLog({
      subjectType: "tool",
      action: "update",
      phase: "completed",
      subjectId: tool.id,
      userId: input.userId,
      workspaceId: tool.workspaceId,
      data: {
        webhook: provider,
        rotated: minted.rotated,
        ...(signingSecret ? { signingSecret: "set" } : {}),
      },
    });
  }

  return {
    provider,
    url: `${origin}/api/webhooks/${provider}/${minted.token}`,
    rotated: minted.rotated,
    missingConfig: spec.requiredConfig.filter((k) => !minted.webhook[k]),
    setupStep: spec.setupStep,
    ...(signingSecret ? { signingSecretSet: true as const } : {}),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Encrypt a webhook signing secret into the vault of the person the route
 * redeems it as, and return its `vault://<id>` reference. Rewrites the row the
 * tool already points at when it is theirs, so setting it again never leaves
 * an orphan behind. The row id is the encryption's AAD, so it is fixed first.
 */
async function storeSigningSecret(
  tx: Tx,
  input: {
    userId: string;
    webhookOwnerId: string;
    toolId: string;
    workspaceId: string | null;
    provider: InboundWebhookProvider;
    signingSecret: string;
    currentRef: string | null;
  }
): Promise<string> {
  if (input.userId !== input.webhookOwnerId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only the person this webhook acts for can set its signing secret: it is kept in their vault, where the webhook reads it.",
    });
  }
  const currentId = input.currentRef
    ? (parseVaultReference(input.currentRef)?.secretId ?? null)
    : null;
  const [existing] = currentId
    ? await tx
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.id, currentId),
            eq(secrets.userId, input.userId),
            isNull(secrets.deletedAt)
          )
        )
        .limit(1)
    : [];
  const secretId = existing?.id ?? randomUUID();
  const blob = encryptServerSide(input.signingSecret, {
    column: "secrets.encrypted_data",
    rowId: secretId,
  });
  if (existing) {
    await tx
      .update(secrets)
      .set({
        encryptedData: blob.encryptedData,
        iv: blob.iv,
        authTag: blob.authTag,
        encryptionMode: "server",
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, secretId));
  } else {
    await tx.insert(secrets).values({
      id: secretId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      name: `${input.provider} webhook signing secret`,
      type: "api_key",
      description: `Verifies the signature of ${input.provider} webhook deliveries to this pod (tool ${input.toolId}).`,
      serviceId: `webhook:${input.provider}:${input.toolId}`,
      encryptionMode: "server",
      encryptedData: blob.encryptedData,
      iv: blob.iv,
      authTag: blob.authTag,
    });
  }
  return makeVaultReference(secretId);
}

/** One installed tool's webhook, as a capability install reports it. */
export type InstalledToolWebhook =
  | ({ tool: string; toolId: string } & ProvisionedInboundWebhook)
  | {
      tool: string;
      toolId: string;
      provider: InboundWebhookProvider;
      error: string;
    };

/**
 * The capability-install step: provision the webhook of every installed tool
 * whose provider calls the pod with a token in the path. A tool still waiting
 * on a proposal (no id yet) has nothing to provision. A failure is REPORTED
 * per tool, never thrown: the tools and skills are already written, so
 * throwing would abort a finished install, and swallowing it would hand back
 * an install that silently has no webhook.
 */
export async function provisionInstalledToolWebhooks(
  installed: ReadonlyArray<{ name: string; toolId: string | null }>,
  userId: string
): Promise<InstalledToolWebhook[]> {
  const out: InstalledToolWebhook[] = [];
  for (const t of installed) {
    const provider = inboundWebhookProviderForTool(t.name);
    if (!provider || !t.toolId) continue;
    try {
      const provisioned = await provisionInboundWebhook({
        userId,
        toolId: t.toolId,
      });
      out.push({ tool: t.name, toolId: t.toolId, ...provisioned });
    } catch (err) {
      out.push({
        tool: t.name,
        toolId: t.toolId,
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
