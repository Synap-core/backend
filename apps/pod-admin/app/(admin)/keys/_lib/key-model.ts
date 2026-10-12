/**
 * What a key IS, as every keys surface shows it: its category badge, its
 * status pill, its scopes as a list. Pure, so `/keys`, `/my-connections` and
 * the workspace keys tab read one rule and cannot drift.
 */

import type { StatusKind } from "../../components/status-pill";

export interface UnifiedKey {
  id: string;
  userId?: string;
  keyName: string;
  keyPrefix: string;
  keyType?: string | null;
  hubId?: string | null;
  linkedUserId?: string | null;
  scope?: string[] | string | null;
  isActive: boolean;
  expiresAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
  usageCount?: number | null;
  createdAt?: Date | string | null;
  revokedAt?: Date | string | null;
  revokedReason?: string | null;
  user?: {
    id: string;
    email: string | null;
    name: string | null;
    userType?: string | null;
  };
}

export type KeyCategory = "agent" | "cli" | "service" | "system" | "operator";

/**
 * Badge category, derived purely from `keyType` (the real signal) — never
 * from `hubId`/`keyPrefix` heuristics, which mislabeled a self-service
 * `/connect` CLI key (keyType `hub_inbound`, `linkedUserId` set to the human
 * it acts for) as "System".
 */
export function categorize(k: UnifiedKey): KeyCategory {
  switch (k.keyType) {
    case "is_internal":
      // The trusted Intelligence-Service pod-read key — operator/system tier.
      return "system";
    case "service":
      return "service";
    case "hub_inbound":
      if (k.linkedUserId) {
        return k.hubId?.startsWith("integration:cli") ? "cli" : "agent";
      }
      return "system";
    default:
      // "system" (admin-minted) and "user_pat" (personal access token) both
      // fall here: "system" is already correctly named by keyType; everything
      // else (personal access tokens) maps to the operator bucket.
      return k.keyType === "system" ? "system" : "operator";
  }
}

export const CATEGORY_LABEL: Record<KeyCategory, string> = {
  agent: "Agent",
  cli: "CLI",
  service: "Service",
  system: "System",
  operator: "Operator",
};

export function keyStatus(apiKey: {
  isActive: boolean;
  expiresAt?: Date | string | null;
}): { kind: StatusKind; label: string } {
  if (!apiKey.isActive) return { kind: "down", label: "Revoked" };
  if (apiKey.expiresAt) {
    const exp = new Date(apiKey.expiresAt).getTime();
    if (exp < Date.now()) return { kind: "stale", label: "Expired" };
    if (exp - Date.now() < 7 * 24 * 60 * 60 * 1000)
      return { kind: "stale", label: "Expiring soon" };
  }
  return { kind: "healthy", label: "Active" };
}

export function normalizeScopes(
  s: string[] | string | null | undefined
): string[] {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
