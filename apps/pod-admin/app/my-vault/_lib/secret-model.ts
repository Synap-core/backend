/**
 * One secret's page, shaped. PURE: `secretsVault.getDetailBundle` (identity
 * without the value, usages, grants, ~20 activity rows) and the owner's
 * `secretsVault.list` row in, sections out — tested at the seam.
 *
 * Two facts the bundle does NOT carry are read from the list row: whether the
 * secret is marked compromised, and when it was last used. A list that
 * failed is `null` here, never "not compromised": the page says it could not
 * read it rather than guessing a calm answer.
 */

import type {
  SecretActivityEvent,
  SecretDetailBundle,
  SecretGrantView,
  SecretUsage,
} from "@synap-core/types/vault";
import { humanizeToken } from "@synap-core/types/vocabulary";
import type { TFunction } from "@synap-core/types/i18n";
import type { StatusKind } from "../../(admin)/components/status-pill";
import type { ExitTarget } from "../../../lib/open-in";
import type { en } from "./copy";

export type SecretT = TFunction<typeof en>;

/** The slice of a `secretsVault.list` row the page reads. */
export interface SecretListRow {
  id: string;
  isCompromised: boolean;
  lastAccessedAt: Date | string | null;
}

export type GrantState = "active" | "expired" | "revoked" | "exhausted";

/** Why a grant is or is not live, from the one canonical `active` flag. */
export function grantState(g: SecretGrantView, now = Date.now()): GrantState {
  if (g.revokedAt) return "revoked";
  if (g.usesRemaining === 0) return "exhausted";
  if (g.expiresAt && new Date(g.expiresAt).getTime() <= now) return "expired";
  return g.active ? "active" : "expired";
}

/** Live grants first (newest as the pod sent them), ended ones apart. */
export function splitGrants(grants: SecretGrantView[]): {
  active: SecretGrantView[];
  ended: SecretGrantView[];
} {
  const active: SecretGrantView[] = [];
  const ended: SecretGrantView[] = [];
  for (const g of grants) (grantState(g) === "active" ? active : ended).push(g);
  return { active, ended };
}

/** What the page could read to name a grant's holder; each part may be absent. */
export interface GranteeLookup {
  /** The owner's `secretsVault.listAllGrants` rows (grantee label + type). */
  grants?: Pick<SecretGrantView, "grantId" | "granteeLabel" | "granteeType">[];
  /** The viewer's spaces (`workspaces.list`), for a space-wide grant. */
  spaces?: { id: string; name: string }[];
}

function shortRef(id: string): string {
  return id.length > 11 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/**
 * Who holds a grant, in words. A grant is given to a user or agent
 * (`grantedTo` = its user id) or, with no `grantedTo`, to a whole space
 * (`workspaceId`). The name comes from what the page could read; when a read
 * failed or the holder is not visible, it says what KIND of holder it is with
 * a short id: never "Unknown", never the bare uuid. The pod's own label falls
 * back to the raw id when the user row is gone, and that is not a name.
 */
export function granteeWords(
  g: SecretGrantView,
  lookup: GranteeLookup,
  t: SecretT
): string {
  if (!g.grantedTo) {
    const space = g.workspaceId
      ? lookup.spaces?.find((w) => w.id === g.workspaceId)
      : undefined;
    if (false) return t("grantee.named.space", { name: space.name });
    return t("grantee.bare.space", { id: shortRef(g.workspaceId ?? "") });
  }
  const row = lookup.grants?.find((x) => x.grantId === g.grantId);
  const label = row?.granteeLabel?.trim();
  const kind = row?.granteeType === "agent" ? "agent" : row ? "user" : null;
  if (label) {
    return kind === "agent"
      ? t("grantee.named.agent", { name: label })
      : t("grantee.named.user", { name: label });
  }
  const id = shortRef(g.grantedTo);
  return kind === "agent"
    ? t("grantee.bare.agent", { id })
    : kind === "user"
      ? t("grantee.bare.user", { id })
      : t("grantee.bare.unknown", { id });
}

/**
 * The secret's one status: compromised outranks everything; then whether any
 * grant is live; `null` for the compromise mark (the list did not answer)
 * says so instead of claiming a calm state.
 */
export function secretStatus(
  bundle: Pick<SecretDetailBundle, "grants">,
  compromised: boolean | null,
  t: SecretT
): { kind: StatusKind; label: string; sentence: string } {
  if (compromised === true) {
    return {
      kind: "down",
      label: t("status.compromised"),
      sentence: t("summary.compromised"),
    };
  }
  if (compromised === null) {
    return {
      kind: "unknown",
      label: t("status.unknown"),
      sentence: t("summary.unknown"),
    };
  }
  const live = splitGrants(bundle.grants).active.length;
  return live > 0
    ? {
        kind: "stale",
        label: t("status.shared"),
        sentence: t("summary.shared", { n: live }),
      }
    : {
        kind: "healthy",
        label: t("status.private"),
        sentence: t("summary.private"),
      };
}

/** The list row for this secret: `null` when the list failed or lacks it. */
export function listRowFor(
  list: SecretListRow[] | undefined,
  id: string
): SecretListRow | null {
  return list?.find((r) => r.id === id) ?? null;
}

/**
 * A usage's own page, when it has one. Only the kinds the console hosts
 * resolve (`HOST_TYPES`); a connection or a bare URL has no page, so it is
 * text — never a link that would land on "not found".
 */
const USAGE_OBJECT_KIND: Partial<Record<SecretUsage["consumerType"], string>> =
  {
    capability: "capability",
    tool: "tool",
    entity: "entity",
    automation: "automation",
  };

export function usageTarget(u: SecretUsage): ExitTarget | null {
  const objectKind = USAGE_OBJECT_KIND[u.consumerType];
  return objectKind ? { kind: "object", objectKind, id: u.consumerId } : null;
}

/** An audit row as one line: the act, and who did it (an agent says so). */
export function activityLine(e: SecretActivityEvent, t: SecretT): string {
  const who = e.actorLabel?.trim() || "—";
  return t("activity.row", {
    action: humanizeToken(e.action),
    who: e.actorType === "agent" ? t("activity.agent", { who }) : who,
  });
}
