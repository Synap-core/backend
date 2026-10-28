/**
 * KEY REQUESTS — how the CLI gets a key (keys plan §3.6, Decision 4; founder
 * 2026-10-27: "the CLI requests a key and opens the pod-admin page where the
 * person validates it, and never mints directly"). The device-flow shape the
 * CLI already speaks for `synap init` (RFC 8628, `machine-connect.ts`):
 *
 *   1. REQUEST (CLI, its own key): `POST /api/hub/keys/requests`
 *      {template, name?, ttl?, space?} → {request_code, request_id, review_url,
 *      expires_in, interval}. The template, as asked, is the request's CEILING.
 *   2. DECIDE (the person, signed in, on pod-admin `/keys/requests/<id>`):
 *      tRPC `apiKeys.getKeyRequest` / `apiKeys.decideKeyRequest`. The person
 *      may narrow the key, never widen it past the ceiling (`validateKeyDraft`
 *      with the ceiling, `@synap-core/types/grants`).
 *   3. COLLECT (CLI, by request code): `POST /api/hub/keys/requests/token` →
 *      the key, ONCE, minted at that moment through `mintPersonKey` (the mint
 *      `apiKeys.create` uses), as the person.
 *
 * The computer sees and revokes ONLY the keys it requested
 * (`listRequestedKeys`, `revokeRequestedKey`): narrowing is safe, and "agents
 * and grant-scoped keys may not revoke the owner's apps" (pod `a451a3e5`)
 * stays intact.
 *
 * SECURITY: the request code is stored as a sha256 hash; no key exists before
 * collection (`key_requests` holds only the draft, then the minted key's id).
 */

import { createHash, randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  count,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  GrantRoleRepository,
} from "@synap/database";
import {
  apiKeys,
  keyRequests,
  users,
  type ApprovedKeyDraft,
  type KeyRequest,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  KEY_TEMPLATES,
  describeKeyProblem,
  grantLifetime,
  keyTemplate,
  validateKeyDraft,
  type GrantDraft,
  type GrantRole,
  type KeyCeiling,
  type KeyDraft,
  type KeyUseId,
} from "@synap-core/types/grants";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { deriveKeyScopes } from "./key-grant.js";
import { mintPersonKey } from "./person-key-mint.js";

/** How long a request waits for its person (a sign-in may come first). */
export const KEY_REQUEST_TTL_SECONDS = 900;
export const KEY_REQUEST_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 5;
/** Requests one requester may have waiting at once. */
export const KEY_REQUEST_MAX_PENDING = 5;

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ── templates ───────────────────────────────────────────────────────────────

/** A template a key can be made from: a built-in, or one of the person's roles that sets its uses. */
export interface KeyTemplateView {
  id: string;
  name: string;
  description: string;
  stored: boolean;
  uses: string[];
  permissions: string[];
  workspaceIds: string[] | null;
  projectIds: string[] | null;
  entityIds: string[] | null;
  /** Days, or null = never; absent = the mint default (90 days). */
  expiresInDays?: number | null;
}

function templateView(role: GrantRole): KeyTemplateView {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    stored: role.stored === true,
    uses: [...(role.uses ?? [])],
    permissions: [...role.grant.permissions],
    workspaceIds: role.grant.workspaceIds ? [...role.grant.workspaceIds] : null,
    projectIds: role.grant.projectIds ? [...role.grant.projectIds] : null,
    entityIds: role.grant.entityIds ? [...role.grant.entityIds] : null,
    ...(role.grant.expiresInDays !== undefined
      ? { expiresInDays: role.grant.expiresInDays }
      : {}),
  };
}

/** The person's stored roles as GrantRoles (only those that set their uses are templates). */
async function storedTemplates(personUserId: string): Promise<GrantRole[]> {
  const rows = await new GrantRoleRepository(db).listForUser(personUserId);
  return rows
    .filter((r) => r.uses && r.uses.length > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      stored: true,
      uses: r.uses as KeyUseId[],
      grant: {
        permissions: r.permissions,
        ...(r.workspaceIds ? { workspaceIds: r.workspaceIds } : {}),
        ...(r.projectIds ? { projectIds: r.projectIds } : {}),
        ...(r.entityIds ? { entityIds: r.entityIds } : {}),
        ...(r.neverExpires
          ? { expiresInDays: null }
          : r.expiresInDays !== null
            ? { expiresInDays: r.expiresInDays }
            : {}),
      },
    }));
}

/** Every template the person can make a key from: built-ins, then their own. */
export async function listKeyTemplates(
  personUserId: string
): Promise<KeyTemplateView[]> {
  return [...KEY_TEMPLATES, ...(await storedTemplates(personUserId))].map(
    templateView
  );
}

async function resolveTemplate(
  personUserId: string,
  templateId: string
): Promise<GrantRole> {
  const builtIn = keyTemplate(templateId);
  if (builtIn) return builtIn;
  const own = (await storedTemplates(personUserId)).find(
    (r) => r.id === templateId
  );
  if (own) return own;
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `No key template "${templateId}". List them with \`synap keys templates\`.`,
  });
}

// ── 1. Request (CLI) ────────────────────────────────────────────────────────

export interface CreateKeyRequestInput {
  /** The principal asking (the computer's agent user, else the person). */
  requesterUserId: string;
  /** The key the request is made with. */
  requesterKeyId: string;
  /** The person who will approve it (the key's human). */
  personUserId: string;
  templateId: string;
  name?: string;
  /** Days, or null = never; omitted = the template's lifetime. */
  expiresInDays?: number | null;
  /** Narrow the key to this space. */
  workspaceId?: string;
  /** pod-admin origin, for `review_url`. */
  podAdminOrigin: string;
}

export interface KeyRequestResponse {
  request_code: string;
  request_id: string;
  review_url: string;
  expires_in: number;
  interval: number;
}

/** The ceiling a request asks for: its template, narrowed by name, lifetime and space. */
export function ceilingFromTemplate(
  template: GrantRole,
  opts: { expiresInDays?: number | null; workspaceId?: string }
): { ceiling: KeyCeiling & { grant: GrantDraft }; problems: string[] } {
  const problems: string[] = [];
  const base = template.grant;
  let workspaceIds = base.workspaceIds ?? null;
  if (opts.workspaceId) {
    if (workspaceIds && !workspaceIds.includes(opts.workspaceId))
      problems.push(
        `The template "${template.name}" does not reach that space.`
      );
    workspaceIds = [opts.workspaceId];
  }
  const grant: GrantDraft = {
    permissions: [...base.permissions],
    ...(workspaceIds ? { workspaceIds } : {}),
    ...(base.projectIds ? { projectIds: base.projectIds } : {}),
    ...(base.entityIds ? { entityIds: base.entityIds } : {}),
    ...(opts.expiresInDays !== undefined
      ? { expiresInDays: opts.expiresInDays }
      : base.expiresInDays !== undefined
        ? { expiresInDays: base.expiresInDays }
        : {}),
  };
  if (opts.expiresInDays !== undefined) {
    const asked = grantLifetime(grant);
    const allowed = grantLifetime(base);
    if (
      allowed.kind !== "never" &&
      (asked.kind === "never" || asked.days > allowed.days)
    )
      problems.push(
        `The template "${template.name}" lasts at most ${allowed.days} days.`
      );
  }
  return { ceiling: { grant, uses: [...(template.uses ?? [])] }, problems };
}

export async function createKeyRequest(
  input: CreateKeyRequestInput
): Promise<KeyRequestResponse> {
  // Housekeeping: requests past their TTL hold nothing anyone can use.
  await db
    .delete(keyRequests)
    .where(
      and(
        lt(keyRequests.expiresAt, new Date()),
        inArray(keyRequests.status, ["pending", "approved", "denied"])
      )
    );

  const template = await resolveTemplate(input.personUserId, input.templateId);
  if (!template.uses || template.uses.length === 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${template.name}" says nothing about where the key is used, so it cannot be requested. Pick a template that does.`,
    });
  const { ceiling, problems } = ceilingFromTemplate(template, {
    expiresInDays: input.expiresInDays,
    workspaceId: input.workspaceId,
  });
  if (problems.length > 0)
    throw new TRPCError({ code: "BAD_REQUEST", message: problems.join(" ") });

  const [{ waiting }] = await db
    .select({ waiting: count() })
    .from(keyRequests)
    .where(
      and(
        eq(keyRequests.requesterUserId, input.requesterUserId),
        eq(keyRequests.status, "pending"),
        gt(keyRequests.expiresAt, new Date())
      )
    );
  if (Number(waiting) >= KEY_REQUEST_MAX_PENDING)
    throw new TRPCError({
      code: "CONFLICT",
      message: `${KEY_REQUEST_MAX_PENDING} key requests are already waiting for your approval. Decide those first.`,
    });

  const requestCode = randomBytes(32).toString("base64url");
  const lifetime = grantLifetime(ceiling.grant);
  const [row] = await db
    .insert(keyRequests)
    .values({
      requestCodeHash: sha256(requestCode),
      status: "pending",
      requesterUserId: input.requesterUserId,
      requesterKeyId: input.requesterKeyId,
      personUserId: input.personUserId,
      templateId: template.id,
      requestedName: input.name?.trim() || template.name,
      requestedUses: [...ceiling.uses],
      requestedPermissions: [...ceiling.grant.permissions],
      requestedWorkspaceIds: ceiling.grant.workspaceIds
        ? [...ceiling.grant.workspaceIds]
        : null,
      requestedProjectIds: ceiling.grant.projectIds
        ? [...ceiling.grant.projectIds]
        : null,
      requestedEntityIds: ceiling.grant.entityIds
        ? [...ceiling.grant.entityIds]
        : null,
      requestedExpiresInDays: lifetime.kind === "days" ? lifetime.days : null,
      requestedNeverExpires: lifetime.kind === "never",
      pollIntervalSeconds: KEY_REQUEST_POLL_INTERVAL_SECONDS,
      expiresAt: new Date(Date.now() + KEY_REQUEST_TTL_SECONDS * 1000),
    })
    .returning({ id: keyRequests.id });

  void auditLog({
    subjectType: "apiKey",
    action: "create",
    phase: "requested",
    subjectId: row!.id,
    userId: input.personUserId,
    agentUserId:
      input.requesterUserId !== input.personUserId
        ? input.requesterUserId
        : undefined,
    workspaceId: input.workspaceId ?? null,
    data: { kind: "key_request", templateId: template.id },
  });

  return {
    request_code: requestCode,
    request_id: row!.id,
    review_url: `${input.podAdminOrigin}/keys/requests/${row!.id}`,
    expires_in: KEY_REQUEST_TTL_SECONDS,
    interval: KEY_REQUEST_POLL_INTERVAL_SECONDS,
  };
}

// ── 2. Review + decide (the person, signed in) ──────────────────────────────

/** The request's ceiling as a KeyDraft (what approving it unchanged mints). */
export function ceilingDraft(row: KeyRequest): KeyDraft {
  return {
    name: row.requestedName,
    templateId: row.templateId,
    uses: [...row.requestedUses],
    grant: {
      permissions: [...row.requestedPermissions],
      ...(row.requestedWorkspaceIds
        ? { workspaceIds: row.requestedWorkspaceIds }
        : {}),
      ...(row.requestedProjectIds
        ? { projectIds: row.requestedProjectIds }
        : {}),
      ...(row.requestedEntityIds ? { entityIds: row.requestedEntityIds } : {}),
      expiresInDays: row.requestedNeverExpires
        ? null
        : row.requestedExpiresInDays,
    },
  };
}

export type KeyRequestStatusView =
  "pending" | "approved" | "denied" | "consumed" | "expired";

export interface KeyRequestView {
  requestId: string;
  status: KeyRequestStatusView;
  /** Who asks: the computer (or the person's own key). */
  requester: { userId: string; name: string; isComputer: boolean };
  template: { id: string; name: string; description: string } | null;
  /** The most the key may be: approving unchanged mints exactly this. */
  draft: KeyDraft;
  createdAt: Date;
  expiresAt: Date;
}

function viewStatus(row: KeyRequest): KeyRequestStatusView {
  if (
    (row.status === "pending" || row.status === "approved") &&
    row.expiresAt.getTime() <= Date.now()
  )
    return "expired";
  return row.status;
}

async function loadOwnRequest(
  requestId: string,
  personUserId: string
): Promise<KeyRequest> {
  const [row] = await db
    .select()
    .from(keyRequests)
    .where(
      and(
        eq(keyRequests.id, requestId),
        eq(keyRequests.personUserId, personUserId)
      )
    )
    .limit(1);
  // Another person's request is NOT_FOUND, never FORBIDDEN: its existence is
  // not theirs to learn.
  if (!row)
    throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
  return row;
}

export async function getKeyRequest(args: {
  requestId: string;
  personUserId: string;
}): Promise<KeyRequestView> {
  const row = await loadOwnRequest(args.requestId, args.personUserId);
  const [requester] = await db
    .select({ id: users.id, name: users.name, userType: users.userType })
    .from(users)
    .where(eq(users.id, row.requesterUserId))
    .limit(1);
  const template =
    keyTemplate(row.templateId) ??
    (await storedTemplates(args.personUserId)).find(
      (r) => r.id === row.templateId
    );
  return {
    requestId: row.id,
    status: viewStatus(row),
    requester: {
      userId: row.requesterUserId,
      name: requester?.name ?? "",
      isComputer: requester?.userType === "agent",
    },
    template: template
      ? {
          id: template.id,
          name: template.name,
          description: template.description,
        }
      : null,
    draft: ceilingDraft(row),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export interface DecideKeyRequestInput {
  requestId: string;
  personUserId: string;
  decision: "approve" | "deny";
  /** Approve: the key as the person set it; omitted = the ceiling unchanged. */
  draft?: KeyDraft;
}

export async function decideKeyRequest(
  input: DecideKeyRequestInput
): Promise<{ status: "approved" | "denied" }> {
  const row = await loadOwnRequest(input.requestId, input.personUserId);
  if (row.status !== "pending")
    throw new TRPCError({
      code: "CONFLICT",
      message: "This request was already decided.",
    });
  if (row.expiresAt.getTime() <= Date.now())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This request expired. Run the command again.",
    });

  if (input.decision === "deny") {
    await db
      .update(keyRequests)
      .set({ status: "denied", approvedByUserId: input.personUserId })
      .where(
        and(eq(keyRequests.id, row.id), eq(keyRequests.status, "pending"))
      );
    void auditLog({
      subjectType: "apiKey",
      action: "create",
      phase: "rejected",
      subjectId: row.id,
      userId: input.personUserId,
      workspaceId: null,
      data: { kind: "key_request", templateId: row.templateId },
    });
    return { status: "denied" };
  }

  const ceiling = ceilingDraft(row);
  const draft = input.draft ?? ceiling;
  const verdict = validateKeyDraft(draft, {
    ceiling: { grant: ceiling.grant, uses: ceiling.uses },
  });
  if (!verdict.ok)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: verdict.problems
        .map((p) => describeKeyProblem(p).text)
        .join(" "),
    });

  // A person deciding in their own session IS the decision, but policy may
  // still refuse a key being made (the device door's rule).
  const perm = await checkPermissionOrPropose({
    userId: input.personUserId,
    subjectType: "apiKey",
    action: "create",
    data: {
      kind: "key_request",
      requestId: row.id,
      templateId: row.templateId,
    },
  });
  if ("denied" in perm && perm.denied)
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  if (!("granted" in perm && perm.granted))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "A key request needs your own approval, signed in.",
    });

  const approved: ApprovedKeyDraft = {
    name: draft.name.trim(),
    uses: [...draft.uses],
    ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
    grant: {
      permissions: [...draft.grant.permissions],
      ...(draft.grant.workspaceIds?.length
        ? { workspaceIds: [...draft.grant.workspaceIds] }
        : {}),
      ...(draft.grant.projectIds?.length
        ? { projectIds: [...draft.grant.projectIds] }
        : {}),
      ...(draft.grant.entityIds?.length
        ? { entityIds: [...draft.grant.entityIds] }
        : {}),
    },
    expiresInDays: (() => {
      const l = grantLifetime(draft.grant);
      return l.kind === "never" ? null : l.days;
    })(),
  };
  const [updated] = await db
    .update(keyRequests)
    .set({
      status: "approved",
      approvedByUserId: input.personUserId,
      approvedAt: new Date(),
      approvedDraft: approved,
    })
    .where(and(eq(keyRequests.id, row.id), eq(keyRequests.status, "pending")))
    .returning({ id: keyRequests.id });
  if (!updated)
    throw new TRPCError({
      code: "CONFLICT",
      message: "This request was already decided.",
    });
  void auditLog({
    subjectType: "apiKey",
    action: "create",
    phase: "approved",
    subjectId: row.id,
    userId: input.personUserId,
    workspaceId: null,
    data: {
      kind: "key_request",
      templateId: row.templateId,
      narrowed: input.draft !== undefined,
    },
  });
  return { status: "approved" };
}

// ── 3. Collect (CLI) ────────────────────────────────────────────────────────

export type KeyRequestTokenError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant";

export interface CollectedRequestedKey {
  apiKey: string;
  keyId: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
}

export type KeyRequestTokenResult =
  | { ok: true; body: CollectedRequestedKey }
  | { ok: false; error: KeyRequestTokenError; interval?: number };

export async function collectKeyRequest(args: {
  requestCode: string;
  /** The principal polling: only the one that asked may collect. */
  requesterUserId: string;
}): Promise<KeyRequestTokenResult> {
  const hash = sha256(args.requestCode);
  const [row] = await db
    .select()
    .from(keyRequests)
    .where(eq(keyRequests.requestCodeHash, hash))
    .limit(1);
  // Someone else's code reads exactly like an unknown one.
  if (!row || row.requesterUserId !== args.requesterUserId)
    return { ok: false, error: "invalid_grant" };
  if (row.status === "consumed" || row.expiresAt.getTime() <= Date.now())
    return { ok: false, error: "expired_token" };

  const now = new Date();
  if (
    row.lastPolledAt &&
    now.getTime() - row.lastPolledAt.getTime() < row.pollIntervalSeconds * 1000
  ) {
    const interval = row.pollIntervalSeconds + SLOW_DOWN_STEP_SECONDS;
    await db
      .update(keyRequests)
      .set({ lastPolledAt: now, pollIntervalSeconds: interval })
      .where(eq(keyRequests.id, row.id));
    return { ok: false, error: "slow_down", interval };
  }
  await db
    .update(keyRequests)
    .set({ lastPolledAt: now })
    .where(eq(keyRequests.id, row.id));

  if (row.status === "denied") return { ok: false, error: "access_denied" };
  if (row.status !== "approved")
    return { ok: false, error: "authorization_pending" };

  // CLAIM before mint: exactly one poll moves approved → consumed.
  const [claimed] = await db
    .update(keyRequests)
    .set({ status: "consumed", consumedAt: now })
    .where(
      and(
        eq(keyRequests.id, row.id),
        eq(keyRequests.status, "approved"),
        gt(keyRequests.expiresAt, now)
      )
    )
    .returning();
  if (!claimed || !claimed.approvedDraft)
    return { ok: false, error: "expired_token" };

  const draft = claimed.approvedDraft;
  const scope = deriveKeyScopes(draft.uses as KeyUseId[], draft.grant);
  const minted = await mintPersonKey({
    personUserId: claimed.personUserId,
    keyName: draft.name,
    scope,
    expiresInDays: draft.expiresInDays,
    grant: draft.grant,
    note: draft.note,
    auditData: {
      kind: "key_request",
      keyRequestId: claimed.id,
      templateId: claimed.templateId,
      requesterUserId: claimed.requesterUserId,
    },
  });
  await db
    .update(keyRequests)
    .set({ mintedKeyId: minted.id })
    .where(eq(keyRequests.id, claimed.id));

  return {
    ok: true,
    body: {
      apiKey: minted.key,
      keyId: minted.id,
      keyPrefix: minted.keyPrefix,
      name: draft.name,
      scopes: scope,
      expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null,
    },
  };
}

// ── The keys a computer requested ──────────────────────────────────────────

export interface RequestedKeyView {
  keyId: string;
  name: string;
  keyPrefix: string;
  templateId: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listRequestedKeys(
  requesterUserId: string
): Promise<RequestedKeyView[]> {
  const rows = await db
    .select({
      keyId: apiKeys.id,
      name: apiKeys.keyName,
      keyPrefix: apiKeys.keyPrefix,
      templateId: keyRequests.templateId,
      scopes: apiKeys.scope,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(keyRequests)
    .innerJoin(apiKeys, eq(apiKeys.id, keyRequests.mintedKeyId))
    .where(
      and(
        eq(keyRequests.requesterUserId, requesterUserId),
        isNotNull(keyRequests.mintedKeyId)
      )
    )
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({ ...r, scopes: [...(r.scopes ?? [])] }));
}

/** Revoke a key this requester asked for; any other key is NOT_FOUND. */
export async function revokeRequestedKey(args: {
  requesterUserId: string;
  keyId: string;
  /** Who revokes (attribution). */
  by: string;
}): Promise<{ revoked: boolean }> {
  const [mine] = await db
    .select({ keyId: keyRequests.mintedKeyId })
    .from(keyRequests)
    .where(
      and(
        eq(keyRequests.requesterUserId, args.requesterUserId),
        eq(keyRequests.mintedKeyId, args.keyId)
      )
    )
    .limit(1);
  if (!mine)
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        "This computer did not request that key. Revoke other keys on the Keys page.",
    });
  const revoked = await revokeApiKeys(db, {
    where: eq(apiKeys.id, args.keyId),
    revokedBy: args.by,
    reason: "Revoked by the computer that requested it",
  });
  return { revoked: revoked.length > 0 };
}
