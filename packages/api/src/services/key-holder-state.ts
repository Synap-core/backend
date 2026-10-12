/**
 * Why does MY key not work? — the holder's view of one API key.
 *
 * A key that fails auth gets one opaque 401 ("Invalid or expired API key").
 * Its holder cannot tell "nobody approved it yet" from "a newer connection
 * replaced it" from "it expired" — and those need three different fixes. The
 * 2026-10-12 incident: a laptop's CLI wrote a still-PENDING key into every
 * config, `whoami` called it "revoked or expired", and the person chased the
 * wrong fix while the real one was one approval click away.
 *
 * Only the holder of the plaintext can ask, and the lookup is BY THAT SECRET
 * (the same `getApiKeyStatus` read every hub request runs, so the answer for a
 * secret the pod never issued costs exactly what a 401 costs today and says
 * nothing: `unknown`). Nothing about any other key is enumerable here. The one
 * fact about a sibling key it does return — when a NEWER connection replaced
 * this one — is that key's creation time and instance label, never its secret,
 * hash or id: enough for the holder to recognise "my other computer did this".
 */

import {
  db,
  apiKeys,
  users,
  eq,
  and,
  ne,
  or,
  lte,
  gt,
  desc,
} from "@synap/database";
import { apiKeyService } from "./api-keys.js";
import { settleRejectedAgentConnect } from "./agent-connect.js";
import { agentApprovalPageUrl } from "../utils/pod-admin-origin.js";
import { shortenKeyId } from "../utils/auth-error.js";

export type KeyHolderStateName =
  "active" | "awaiting_approval" | "revoked" | "expired" | "unknown";

export interface KeyHolderState {
  state: KeyHolderStateName;
  /** First 8 chars of the key id — the same safe prefix the 401 envelope carries. */
  keyIdPrefix?: string;
  /** The key's own id (the holder already holds far more: the secret itself). */
  keyId?: string;
  agentType?: string | null;
  /** This key's instance label (`api_keys.instance_id`); null = unlabelled (legacy). */
  instanceId?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  /** `awaiting_approval` only: where the person approves it (pod-admin). */
  approvalUrl?: string;
  /** `revoked` only. */
  revokedAt?: string | null;
  revokedReason?: string | null;
  /**
   * `revoked` by REPLACEMENT only: the connection that replaced this key —
   * when it was created and on which instance. Null when the reason names a
   * replacement but the replacer cannot be found (it was itself removed).
   */
  replacedBy?: { createdAt: string; instanceId: string | null } | null;
}

/**
 * The revoke reasons that mean "a newer key took this one's place" — the
 * approval of a pending connection (`approvePendingAgentKey`) and a direct
 * re-provision (`provisionSurfaceAgentKey`). Matched on the word, so a
 * reworded reason that still says "replaced" keeps classifying; a tripwire
 * pins both literals to it.
 */
export function isReplacementReason(
  reason: string | null | undefined
): boolean {
  return !!reason && /\breplaced\b/i.test(reason);
}

/**
 * Describe the key whose plaintext was presented. Read-only except for one
 * lazy settle the approval poll also runs: a pending key whose `agent/connect`
 * proposal was rejected on its own is revoked here, so its holder hears
 * `revoked` instead of waiting on a request nobody will approve.
 */
export async function describeKeyForHolder(
  plainKey: string,
  requestUrl: string
): Promise<KeyHolderState> {
  const status = await apiKeyService.getApiKeyStatus(plainKey);
  if (status.status === "invalid_format" || status.status === "not_found")
    return { state: "unknown" };

  const record = status.record;
  const owner = await db.query.users.findFirst({
    where: eq(users.id, record.userId),
    columns: { agentType: true },
  });
  const base = {
    keyIdPrefix: shortenKeyId(record.id) ?? undefined,
    keyId: record.id,
    agentType: owner?.agentType ?? null,
    instanceId: record.instanceId ?? null,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
  };

  if (status.status === "valid") return { state: "active", ...base };
  if (status.status === "expired") return { state: "expired", ...base };

  // Inactive. Never revoked = still waiting for its owner's approval — unless
  // its request was rejected on its own, which this settles (and reports).
  if (!record.revokedAt) {
    if (await settleRejectedAgentConnect(record.id)) {
      const settled = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, record.id),
        columns: { revokedAt: true, revokedReason: true },
      });
      return {
        state: "revoked",
        ...base,
        revokedAt: settled?.revokedAt?.toISOString() ?? null,
        revokedReason: settled?.revokedReason ?? null,
      };
    }
    return {
      state: "awaiting_approval",
      ...base,
      approvalUrl: agentApprovalPageUrl(
        requestUrl,
        record.id,
        owner?.agentType ?? "agent"
      ),
    };
  }

  const revoked: KeyHolderState = {
    state: "revoked",
    ...base,
    revokedAt: record.revokedAt.toISOString(),
    revokedReason: record.revokedReason ?? null,
  };
  if (!isReplacementReason(record.revokedReason)) return revoked;

  // The replacer: the same agent's newest key created before this one was
  // revoked that was live at that moment — still active, or revoked only
  // later. A request that was never approved (inactive, never revoked) is not
  // it; neither is anything created after.
  const [replacer] = await db
    .select({ createdAt: apiKeys.createdAt, instanceId: apiKeys.instanceId })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, record.userId),
        eq(apiKeys.keyType, record.keyType),
        ne(apiKeys.id, record.id),
        lte(apiKeys.createdAt, record.revokedAt),
        or(eq(apiKeys.isActive, true), gt(apiKeys.revokedAt, record.revokedAt))
      )
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return {
    ...revoked,
    replacedBy: replacer
      ? {
          createdAt: replacer.createdAt.toISOString(),
          instanceId: replacer.instanceId ?? null,
        }
      : null,
  };
}
