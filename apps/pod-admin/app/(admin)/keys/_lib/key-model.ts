/**
 * What a key IS, as every keys surface shows it: its category badge, its
 * status pill, its scopes as a list. Pure, so `/keys`, `/my-connections` and
 * the workspace keys tab read one rule and cannot drift.
 */

import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";
import { appHref } from "../../applications/_lib/app-inventory";

/**
 * Who holds a key — `apiKeys.list` / `adminListAll` project it (`KeyHolder`
 * in `packages/api/src/routers/api-keys.ts`). An app key, a computer key and
 * a person's own token share `keyType: "user_pat"`; only this tells them
 * apart. `null` = the holder row is gone; absent = a list that does not carry
 * it (`listSystemKeys`).
 */
export interface KeyHolder {
  kind: "app" | "computer" | "agent" | "person";
  name: string | null;
  /** An app holder's `public_id` — its page on Apps (`holderHref`). */
  appId?: string;
}

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
  holder?: KeyHolder | null;
}

export type KeyCategory =
  "app" | "computer" | "agent" | "cli" | "service" | "system" | "operator";

/**
 * Badge category, from `keyType` and the key's HOLDER — never from
 * `hubId`/`keyPrefix` heuristics, which mislabeled a self-service `/connect`
 * CLI key (keyType `hub_inbound`, `linkedUserId` set to the human it acts for)
 * as "System".
 *
 * The holder is read because `keyType` alone lies by omission: an app's key
 * (`app-connect.ts`) and a computer's key (`machine-connect.ts`) are minted as
 * `user_pat`, the same type as a person's own token, and both read "Operator"
 * — a human credential — until the holder was on the wire.
 */
export function categorize(k: UnifiedKey): KeyCategory {
  switch (k.keyType) {
    case "is_internal":
      // The trusted Intelligence-Service pod-read key — operator/system tier.
      return "system";
    case "service":
      return "service";
  }
  if (k.holder?.kind === "app") return "app";
  if (k.holder?.kind === "computer") return "computer";
  switch (k.keyType) {
    case "hub_inbound":
      if (k.linkedUserId) {
        return k.hubId?.startsWith("integration:cli") ? "cli" : "agent";
      }
      return "system";
    case "system":
      return "system";
    default:
      // A personal access token: an agent's when an agent holds it, else a
      // person's own (the operator bucket).
      return k.holder?.kind === "agent" ? "agent" : "operator";
  }
}

/** Nouns from the vocabulary where the pod has one; the rest are key words. */
export const CATEGORY_LABEL: Record<KeyCategory, string> = {
  app: resolveObjectNoun("application"),
  computer: resolveObjectNoun("machine"),
  agent: resolveObjectNoun("agent"),
  cli: "CLI",
  service: "Service",
  system: "System",
  operator: "Operator",
};

/**
 * The holder's name, for a key a person did not mint for themselves — "which
 * app / computer / agent is this?". A person's own key names no one.
 */
export function holderName(k: UnifiedKey): string | null {
  if (!k.holder || k.holder.kind === "person") return null;
  return k.holder.name?.trim() || null;
}

/**
 * Where the key's holder has its own page: an app's key opens its app on
 * Apps (`appHref`). null = the holder has no page to open from here.
 */
export function holderHref(k: UnifiedKey): string | null {
  if (k.holder?.kind === "app" && k.holder.appId) {
    return appHref("key", k.holder.appId);
  }
  return null;
}

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
