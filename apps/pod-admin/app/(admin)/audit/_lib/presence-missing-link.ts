/**
 * The audit log's "went through without a proof" lens: the approvals and
 * changes report mode let through without a proof of presence (the
 * `presence.missing` events). ONE address contract for both ends: the Security
 * card builds its doors with `presenceMissingHref`, the audit page reads them
 * with `readPresenceMissingLens`.
 *
 *   /audit?presence=missing             every kind
 *   /audit?presence=missing&kind=<kind> one kind (`data.proposalType`)
 */
import {
  SENSITIVE_ACTIONS,
  sensitiveActionTitle,
  type SensitiveActionPath,
} from "@synap-core/types/presence";
import {
  buildObjectActionTitle,
  humanizeToken,
} from "@synap-core/types/vocabulary";

const AUDIT_PATH = "/audit";
const LENS_PARAM = "presence";
const LENS_VALUE = "missing";
const KIND_PARAM = "kind";

/** The window the Security card counts (`missingSince`), and the page's default. */
export const PRESENCE_MISSING_DAYS = 30;

/** The lens is on; `kind` absent = every kind. */
export interface PresenceMissingLens {
  kind?: string;
}

/** The audit log filtered to what went through without a proof, of one kind or all. */
export function presenceMissingHref(kind?: string): string {
  const params = new URLSearchParams({ [LENS_PARAM]: LENS_VALUE });
  if (kind) params.set(KIND_PARAM, kind);
  return `${AUDIT_PATH}?${params.toString()}`;
}

/** The lens an address asks for, or `null` when it asks for the plain audit log. */
export function readPresenceMissingLens(
  params: { get(name: string): string | null } | null | undefined
): PresenceMissingLens | null {
  if (params?.get(LENS_PARAM) !== LENS_VALUE) return null;
  const kind = params.get(KIND_PARAM)?.trim();
  return kind ? { kind } : {};
}

/** `listAuditLogs`'s `presenceMissing` input: `{}` asks for every kind, `undefined` for no lens. */
export function presenceMissingQuery(
  lens: PresenceMissingLens | null
): { kind?: string } | undefined {
  if (!lens) return undefined;
  return lens.kind ? { kind: lens.kind } : {};
}

/**
 * A kind's words, the one derivation the Security card and this page share.
 * A kind is a sensitive action path (`apiKeys.create`: its title through the
 * title door), an approval's `<targetType>/<proposalType>` (the proposal's own
 * title words) or a request kind (`key_request`).
 */
export function presenceKindWords(kind: string): string {
  if (Object.hasOwn(SENSITIVE_ACTIONS, kind)) {
    return sensitiveActionTitle(kind as SensitiveActionPath);
  }
  const slash = kind.indexOf("/");
  if (slash > 0) {
    return buildObjectActionTitle({
      objectKind: kind.slice(0, slash),
      action: kind.slice(slash + 1),
    });
  }
  return humanizeToken(kind);
}
