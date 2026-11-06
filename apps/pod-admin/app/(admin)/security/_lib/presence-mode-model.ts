/**
 * The "Approvals need you in person" card, derived in one place from
 * `presence.mode` (pure, so each state is tested):
 *  - the mark: ON (`enforce`) or OFF (`report`), in the shared presence words;
 *  - where the mode comes from: the operator's env floor (ON, and it cannot
 *    be switched off here), a pod admin's change, or the default;
 *  - what `report` let through in the last 30 days (`presence.missing`), by
 *    kind, capped, each row a door to the audit log filtered to that kind,
 *    and "Show all N" to all of them;
 *  - whether turning it ON asks first: only when the person has no factor to
 *    turn it off again with (or their factors could not be read).
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import {
  presenceKindWords,
  presenceMissingHref,
} from "../../audit/_lib/presence-missing-link";
import type { StatusKind } from "../../components/status-pill";

type Outputs = inferRouterOutputs<AppRouter>["presence"];

/** `presence.mode`'s answer. */
export type PresenceModeRead = Outputs["mode"];

/** `presence.factors`' answer. */
export type PresenceFactors = Outputs["factors"];

/** How many kinds the card lists before "Show all". */
export const MISSING_CAP = 3;

/** `missingSince` files a row with no kind under this one: nothing to open. */
const UNKNOWN_KIND = "unknown";

export interface PresenceModeView {
  on: boolean;
  mark: { kind: StatusKind; word: "presence.on" | "presence.off" };
  line: "presence.line.on" | "presence.line.off";
  source:
    | { word: "presence.source.env" }
    | { word: "presence.source.changed"; at: string }
    | { word: "presence.source.default" };
  /** The switch can move: not while the operator's env holds it ON. */
  canSwitch: boolean;
  missing: {
    word:
      | "presence.missing.none"
      | "presence.missing.wouldRefuse"
      | "presence.missing.before";
    total: number;
    /** Each kind, a door to its audit rows (none for an unknown kind). */
    rows: Array<{
      kind: string;
      label: string;
      count: number;
      href: string | null;
    }>;
    /** The audit log of every kind, when the rows leave some out. */
    showAll: { href: string; n: number } | null;
  };
}

export function presenceModeView(read: PresenceModeRead): PresenceModeView {
  const on = read.mode === "enforce";
  const source: PresenceModeView["source"] =
    read.source === "env"
      ? { word: "presence.source.env" }
      : read.source === "setting" && read.changedAt
        ? { word: "presence.source.changed", at: read.changedAt }
        : { word: "presence.source.default" };
  const { total, byKind } = read.missingLast30d;
  const rows = byKind.slice(0, MISSING_CAP).map((r) => ({
    kind: r.kind,
    label: presenceKindWords(r.kind),
    count: r.count,
    href: r.kind === UNKNOWN_KIND ? null : presenceMissingHref(r.kind),
  }));
  return {
    on,
    mark: on
      ? { kind: "healthy", word: "presence.on" }
      : { kind: "stale", word: "presence.off" },
    line: on ? "presence.line.on" : "presence.line.off",
    source,
    canSwitch: read.source !== "env",
    missing: {
      word:
        total === 0
          ? "presence.missing.none"
          : on
            ? "presence.missing.before"
            : "presence.missing.wouldRefuse",
      total,
      rows: total === 0 ? [] : rows,
      showAll:
        total > 0 && byKind.length > rows.length
          ? { href: presenceMissingHref(), n: total }
          : null,
    },
  };
}

/**
 * Does turning it ON ask first? Turning it OFF again needs a proof, so the
 * person is asked only when they hold no factor to give one (a passkey, a
 * Relay device key), or when that could not be read: never a needless
 * dialog for someone who can already prove.
 */
export function turningOnAsks(factors: {
  isError: boolean;
  data?: PresenceFactors | undefined;
}): boolean {
  if (factors.isError || !factors.data) return true;
  return factors.data.passkeys + factors.data.deviceKeys === 0;
}
