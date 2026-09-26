/**
 * THE FORMS DOOR (Sites W4) — the owner's only way to create, edit, re-token,
 * enable/disable and read a public form. The tRPC `forms` router and the Hub
 * REST `/forms` routes both call this module; nothing else writes a form row.
 *
 * WHO: the workspace OWNER, signed in as a person. An agent, an AI-sourced call
 * and any API key are refused — a form mints a public write surface and a
 * secret, and "agents only propose": this wave ships no agent proposal door for
 * forms (see the W4 report), so an agent has no form door at all.
 *
 * WHAT a create mints, in ONE transaction (nothing half-exists):
 *   1. the form's own agent user — `agentType: form:<formId>`, `createdVia:
 *      system`, capabilities EXACTLY `["entity.create"]` (never empty: empty
 *      means unrestricted), `writesRequireProposal: true`, no API key;
 *   2. an `editor` membership in exactly the form's workspace;
 *   3. the per-form mode rule (agent principal, workspace scope, exact action
 *      `entity.create`, `propose` or `auto`), namespaced `system:forms:<id>`;
 *   4. an explicit `pending_proposal_cap` ceiling for that actor;
 *   5. the `tools` row whose `metadata.form` carries the definition, the token
 *      HASH + 6-char prefix and the ticket secret. The plaintext token is
 *      returned ONCE and never stored (`utils/share-token.ts`, the S3 machinery).
 *
 * This module never deletes the actor: `disable` flips the tool status, and the
 * guest door treats a missing/inactive row as a miss.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  getDb,
  and,
  eq,
  isNull,
  drizzleSql,
  getActingAgentUserId,
} from "@synap/database";
import {
  tools,
  users,
  workspaces,
  workspaceMembers,
  governanceRules,
  governanceCeilings,
  profiles,
  type AgentMetadata,
} from "@synap/database/schema";
import { generateShareToken, hashToken } from "../../utils/share-token.js";
import { auditLog } from "../../utils/audit-log.js";
import {
  FORM_ACTOR_CAPABILITIES,
  FormConfigSchema,
  formActorType,
  formRuleCreatedBy,
  isFormToolMetadata,
  parseStoredForm,
  type FormConfig,
  type StoredFormDefinition,
} from "./form-definition.js";

export interface FormActor {
  userId: string;
  agentUserId?: string | null;
  source?: string | null;
  keyType?: string | null;
}

export interface FormSummary {
  id: string;
  workspaceId: string;
  status: string;
  config: FormConfig;
  tokenPrefix: string | null;
  hasToken: boolean;
  actorUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

type Db = Awaited<ReturnType<typeof getDb>>;

const FORM_TOOL_KIND = "external" as const;

function forbidden(message: string) {
  return new TRPCError({ code: "FORBIDDEN", message });
}
const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: "Form not found." });

/** A signed-in person only. Same rule as the S3 secret-minting doors. */
export function assertFormOwnerSession(actor: FormActor): void {
  if (
    getActingAgentUserId() ||
    actor.agentUserId ||
    actor.keyType ||
    actor.source === "ai" ||
    actor.source === "intelligence"
  ) {
    throw forbidden(
      "Public forms are managed by a signed-in person; agents and API keys cannot create or change them."
    );
  }
}

async function assertWorkspaceOwner(
  database: Db,
  userId: string,
  workspaceId: string
): Promise<void> {
  const [ws] = await database
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws)
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
  if (ws.ownerId !== userId) {
    throw forbidden("Only the workspace owner can manage its public forms.");
  }
}

function parseConfig(input: unknown): FormConfig {
  const parsed = FormConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid form: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  }
  return parsed.data;
}

/** The kind must be a live KIND on this pod (the code allowlist already ran). */
async function assertKindExists(
  database: Db,
  kind: string,
  workspaceId: string
): Promise<void> {
  const [row] = await database
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.slug, kind),
        eq(profiles.profileKind, "kind"),
        eq(profiles.isActive, true),
        drizzleSql`(${profiles.workspaceId} is null or ${profiles.workspaceId} = ${workspaceId})`
      )
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This pod has no '${kind}' kind to create.`,
    });
  }
}

async function loadOwnedForm(
  database: Db,
  actor: FormActor,
  formId: string
): Promise<{
  row: typeof tools.$inferSelect;
  form: StoredFormDefinition;
  workspaceId: string;
}> {
  const [row] = await database
    .select()
    .from(tools)
    .where(eq(tools.id, formId))
    .limit(1);
  if (!row || !isFormToolMetadata(row.metadata) || !row.workspaceId) {
    throw notFound();
  }
  await assertWorkspaceOwner(database, actor.userId, row.workspaceId);
  const form = parseStoredForm(row.metadata);
  if (!form) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "This form's stored definition is unreadable.",
    });
  }
  return { row, form, workspaceId: row.workspaceId };
}

function summarize(
  row: typeof tools.$inferSelect,
  form: StoredFormDefinition
): FormSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId!,
    status: row.status,
    config: form.config,
    tokenPrefix: form.tokenPrefix,
    hasToken: form.tokenHash !== null,
    actorUserId: form.actorUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function newTicketSecret(): string {
  return randomBytes(32).toString("hex");
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createForm(
  actor: FormActor,
  input: { workspaceId: string; config: unknown }
): Promise<{ form: FormSummary; token: string; tokenPrefix: string }> {
  assertFormOwnerSession(actor);
  const database = await getDb();
  await assertWorkspaceOwner(database, actor.userId, input.workspaceId);
  const config = parseConfig(input.config);
  await assertKindExists(database, config.kind, input.workspaceId);

  const formId = randomUUID();
  const actorId = randomUUID();
  const token = generateShareToken();
  const tokenPrefix = token.slice(0, 6);
  const stored: StoredFormDefinition = {
    version: 1,
    config,
    actorUserId: actorId,
    tokenHash: hashToken(token),
    tokenPrefix,
    ticketSecret: newTicketSecret(),
  };
  const agentType = formActorType(formId);
  const agentMetadata: AgentMetadata = {
    agentType,
    description: `Files guest submissions of the public form "${config.name}".`,
    createdByUserId: actor.userId,
    isPersonalAgent: false,
    capabilities: [...FORM_ACTOR_CAPABILITIES],
    writesRequireProposal: true,
  };

  const [row] = await database.transaction(async (tx) => {
    await tx.insert(users).values({
      id: actorId,
      email: `agent-form-${actorId.slice(0, 8)}@synap.agent`,
      name: `Form: ${config.name}`.slice(0, 200),
      emailVerified: true,
      userType: "agent",
      createdVia: "system",
      agentMetadata,
      agentType,
      createdByUserId: actor.userId,
      isPersonalAgent: false,
      timezone: "UTC",
      locale: "en",
    });
    await tx.insert(workspaceMembers).values({
      workspaceId: input.workspaceId,
      userId: actorId,
      role: "editor",
      invitedBy: actor.userId,
    });
    await tx.insert(governanceRules).values({
      principalKind: "agent",
      agentUserId: actorId,
      scopeKind: "workspace",
      workspaceId: input.workspaceId,
      targetKind: "action",
      targetPattern: "entity.create",
      verdict: config.mode === "direct" ? "auto" : "propose",
      createdBy: formRuleCreatedBy(formId),
    });
    await tx.insert(governanceCeilings).values({
      axis: "pending_proposal_cap",
      principalKind: "agent",
      agentUserId: actorId,
      scopeKind: "pod",
      limitValue: config.limits.pendingCap,
      createdBy: formRuleCreatedBy(formId),
    });
    return tx
      .insert(tools)
      .values({
        id: formId,
        workspaceId: input.workspaceId,
        createdBy: actor.userId,
        name: config.name,
        description: "Public form",
        kind: FORM_TOOL_KIND,
        executor: "external-agent",
        status: "active",
        approved: false,
        metadata: { form: stored },
      })
      .returning();
  });

  auditLog({
    subjectType: "tool",
    action: "create",
    phase: "completed",
    subjectId: formId,
    userId: actor.userId,
    workspaceId: input.workspaceId,
    // Never the token or its hash.
    data: { form: true, kind: config.kind, mode: config.mode, tokenPrefix },
  });
  return { form: summarize(row!, stored), token, tokenPrefix };
}

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * Replace the owner-settable config. Server-owned parts (actor, token hash,
 * ticket secret) are carried over. A mode change rewrites the per-form rule in
 * the same transaction; a cap change rewrites the ceiling.
 */
export async function updateForm(
  actor: FormActor,
  input: { formId: string; config: unknown }
): Promise<FormSummary> {
  assertFormOwnerSession(actor);
  const database = await getDb();
  const { form, workspaceId } = await loadOwnedForm(
    database,
    actor,
    input.formId
  );
  const config = parseConfig(input.config);
  await assertKindExists(database, config.kind, workspaceId);
  const stored: StoredFormDefinition = { ...form, config };

  const [row] = await database.transaction(async (tx) => {
    if (config.mode !== form.config.mode) {
      await tx
        .update(governanceRules)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(governanceRules.agentUserId, form.actorUserId),
            eq(governanceRules.createdBy, formRuleCreatedBy(input.formId)),
            isNull(governanceRules.revokedAt)
          )
        );
      await tx.insert(governanceRules).values({
        principalKind: "agent",
        agentUserId: form.actorUserId,
        scopeKind: "workspace",
        workspaceId,
        targetKind: "action",
        targetPattern: "entity.create",
        verdict: config.mode === "direct" ? "auto" : "propose",
        createdBy: formRuleCreatedBy(input.formId),
      });
    }
    if (config.limits.pendingCap !== form.config.limits.pendingCap) {
      await tx
        .update(governanceCeilings)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(governanceCeilings.agentUserId, form.actorUserId),
            eq(governanceCeilings.createdBy, formRuleCreatedBy(input.formId)),
            isNull(governanceCeilings.revokedAt)
          )
        );
      await tx.insert(governanceCeilings).values({
        axis: "pending_proposal_cap",
        principalKind: "agent",
        agentUserId: form.actorUserId,
        scopeKind: "pod",
        limitValue: config.limits.pendingCap,
        createdBy: formRuleCreatedBy(input.formId),
      });
    }
    return tx
      .update(tools)
      .set({
        name: config.name,
        metadata: { form: stored },
        updatedAt: new Date(),
      })
      .where(eq(tools.id, input.formId))
      .returning();
  });
  auditLog({
    subjectType: "tool",
    action: "update",
    phase: "completed",
    subjectId: input.formId,
    userId: actor.userId,
    workspaceId,
    data: { form: true, kind: config.kind, mode: config.mode },
  });
  return summarize(row!, stored);
}

// ── Rotate / enable ──────────────────────────────────────────────────────────

/** Mint a new token (returned ONCE); the old one stops working immediately. */
export async function rotateFormToken(
  actor: FormActor,
  formId: string
): Promise<{ formId: string; token: string; tokenPrefix: string }> {
  assertFormOwnerSession(actor);
  const database = await getDb();
  const { form, workspaceId } = await loadOwnedForm(database, actor, formId);
  const token = generateShareToken();
  const tokenPrefix = token.slice(0, 6);
  const stored: StoredFormDefinition = {
    ...form,
    tokenHash: hashToken(token),
    tokenPrefix,
    ticketSecret: newTicketSecret(),
  };
  await database
    .update(tools)
    .set({ metadata: { form: stored }, updatedAt: new Date() })
    .where(eq(tools.id, formId));
  auditLog({
    subjectType: "tool",
    action: "update",
    phase: "completed",
    subjectId: formId,
    userId: actor.userId,
    workspaceId,
    data: { form: true, tokenRotated: true, tokenPrefix },
  });
  return { formId, token, tokenPrefix };
}

export async function setFormEnabled(
  actor: FormActor,
  input: { formId: string; enabled: boolean }
): Promise<FormSummary> {
  assertFormOwnerSession(actor);
  const database = await getDb();
  const { form, workspaceId } = await loadOwnedForm(
    database,
    actor,
    input.formId
  );
  const [row] = await database
    .update(tools)
    .set({
      status: input.enabled ? "active" : "inactive",
      updatedAt: new Date(),
    })
    .where(eq(tools.id, input.formId))
    .returning();
  auditLog({
    subjectType: "tool",
    action: "update",
    phase: "completed",
    subjectId: input.formId,
    userId: actor.userId,
    workspaceId,
    data: { form: true, enabled: input.enabled },
  });
  return summarize(row!, form);
}

// ── Reads (owner) ────────────────────────────────────────────────────────────

export async function getForm(
  actor: FormActor,
  formId: string
): Promise<FormSummary> {
  const database = await getDb();
  const { row, form } = await loadOwnedForm(database, actor, formId);
  return summarize(row, form);
}

export const LIST_FORMS_CAP = 100;

export async function listForms(
  actor: FormActor,
  workspaceId: string
): Promise<FormSummary[]> {
  const database = await getDb();
  await assertWorkspaceOwner(database, actor.userId, workspaceId);
  const rows = await database
    .select()
    .from(tools)
    .where(
      and(
        eq(tools.workspaceId, workspaceId),
        drizzleSql`${tools.metadata} ? 'form'`
      )
    )
    .limit(LIST_FORMS_CAP);
  const out: FormSummary[] = [];
  for (const row of rows) {
    const form = parseStoredForm(row.metadata);
    if (form) out.push(summarize(row, form));
  }
  return out;
}
