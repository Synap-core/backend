/**
 * The "Approvals need you in person" card (W3 slice 3), derived in one place
 * from `presence.mode` (pure, so each state is tested):
 *  - the mark: ON (`enforce`) or recording only (`report`);
 *  - where the mode comes from: the operator's env floor (ON, and it cannot
 *    be switched off here), a pod admin's change, or the default;
 *  - what `report` let through in the last 30 days (`presence.missing`), by
 *    what it was, capped, named through the vocabulary door, never a raw
 *    token.
 */
import {
  PRESENCE_REQUEST_KINDS,
  SENSITIVE_ACTIONS,
  type SensitiveActionPath,
} from "@synap-core/types/presence";
import {
  buildObjectActionTitle,
  humanizeToken,
} from "@synap-core/types/vocabulary";
import { actionDoing } from "../../../_lib/presence/action-words";
import type { StatusKind } from "../../components/status-pill";

/** `presence.mode`'s answer (dates as the tRPC transformer hands them). */
export interface PresenceModeRead {
  mode: "enforce" | "report";
  source: "env" | "setting" | "default";
  changedAt: string | Date | null;
  changedBy: string | null;
  missingLast30d: {
    total: number;
    byKind: ReadonlyArray<{ kind: string; count: number }>;
  };
}

/** How many kinds the card lists before "Show all". */
export const MISSING_CAP = 3;

export interface PresenceModeView {
  on: boolean;
  mark: { kind: StatusKind; word: "presence.mark.on" | "presence.mark.off" };
  line: "presence.line.on" | "presence.line.off";
  source:
    | { word: "presence.source.env" }
    | { word: "presence.source.changed"; at: string | Date }
    | { word: "presence.source.default" };
  /** The switch can move: not while the operator's env holds it ON. */
  canSwitch: boolean;
  missing: {
    word:
      | "presence.missing.none"
      | "presence.missing.wouldRefuse"
      | "presence.missing.before";
    total: number;
    rows: Array<{ label: string; count: number }>;
    /** Kinds left out of `rows` until "Show all". */
    more: number;
  };
}

/** The first letter of a sentence-case phrase of our own catalog (en, fr). */
function sentenceStart(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * What a `presence.missing` kind was, in words: a sensitive action's path
 * (what the person did), a request kind, or an approval's
 * `targetType/proposalType` (the proposal's own title words).
 */
export function missingKindLabel(kind: string): string {
  if (Object.hasOwn(SENSITIVE_ACTIONS, kind)) {
    return sentenceStart(actionDoing(kind as SensitiveActionPath));
  }
  if (Object.hasOwn(PRESENCE_REQUEST_KINDS, kind)) return humanizeToken(kind);
  const slash = kind.indexOf("/");
  if (slash > 0) {
    return buildObjectActionTitle({
      action: kind.slice(slash + 1),
      objectKind: kind.slice(0, slash),
    });
  }
  return humanizeToken(kind);
}

export function presenceModeView(
  read: PresenceModeRead,
  opts: { showAll?: boolean } = {}
): PresenceModeView {
  const on = read.mode === "enforce";
  const source: PresenceModeView["source"] =
    read.source === "env"
      ? { word: "presence.source.env" }
      : read.source === "setting" && read.changedAt
        ? { word: "presence.source.changed", at: read.changedAt }
        : { word: "presence.source.default" };
  const { total, byKind } = read.missingLast30d;
  const all = byKind.map((r) => ({
    label: missingKindLabel(r.kind),
    count: r.count,
  }));
  const rows = opts.showAll ? all : all.slice(0, MISSING_CAP);
  return {
    on,
    mark: on
      ? { kind: "healthy", word: "presence.mark.on" }
      : { kind: "stale", word: "presence.mark.off" },
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
      more: total === 0 ? 0 : all.length - rows.length,
    },
  };
}
