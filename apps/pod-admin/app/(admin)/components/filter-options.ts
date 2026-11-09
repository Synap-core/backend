/**
 * The marks of a filter's values, resolved in one place so a chip's options
 * look the same on every list (decision afab5911): a STATUS value carries a
 * status glyph and tone, a KIND value carries the kind's own icon and colour
 * (the vocabulary registry's, overridden by the profile's `uiHints`).
 *
 * The words are never written here: a status's label is
 * `resolveStatusLabel`, a kind's is `resolveObjectNoun`. Only the glyph of a
 * status key is chosen here (a status has no registry glyph).
 */

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clock,
  MessageSquareWarning,
  Moon,
  PauseCircle,
  PencilLine,
  PlayCircle,
  XCircle,
} from "lucide-react";
import { getEnumTone, type EnumTone } from "@synap-core/types/property-render";
import {
  resolveObjectIdentity,
  resolveStatusLabel,
  type ProfileIdentityInput,
} from "@synap-core/types/vocabulary";
import { kindIcon } from "../../_lib/object/kind-icon";
import type { FilterOption, FilterTone } from "./filter-chip-model";

const TONE_OF_ENUM: Record<EnumTone, FilterTone> = {
  positive: "healthy",
  active: "healthy",
  pending: "stale",
  negative: "down",
  neutral: "unknown",
};

/** A status key → its glyph and tone, for the keys the console's filters use. */
const STATUS_MARKS: Record<string, Pick<FilterOption, "icon" | "tone">> = {
  failed: { icon: XCircle, tone: "down" },
  failing: { icon: XCircle, tone: "down" },
  chat: { icon: MessageSquareWarning, tone: "down" },
  running: { icon: PlayCircle, tone: "healthy" },
  active: { icon: PlayCircle, tone: "healthy" },
  succeeded: { icon: CheckCircle2, tone: "healthy" },
  completed: { icon: CheckCircle2, tone: "healthy" },
  closed: { icon: CheckCircle2, tone: "unknown" },
  queued: { icon: Clock, tone: "stale" },
  pending: { icon: Clock, tone: "stale" },
  waiting: { icon: Clock, tone: "stale" },
  stuck: { icon: AlertTriangle, tone: "stale" },
  paused: { icon: PauseCircle, tone: "unknown" },
  idle: { icon: Moon, tone: "unknown" },
  "never-ran": { icon: CircleDashed, tone: "unknown" },
  drafts: { icon: PencilLine, tone: "unknown" },
  cancelled: { icon: Ban, tone: "unknown" },
};

/**
 * One value of a status filter. `label` is given when the page's own words
 * say more than the status ("Failed AI turns", "Waiting on you"); otherwise
 * the vocabulary's. An unknown key draws a neutral ring and the tone the
 * property renderer gives it.
 */
export function statusOption<K extends string>(
  id: K,
  extra: { label?: string; count?: number | string | null } = {}
): FilterOption<K> {
  const mark = STATUS_MARKS[id] ?? {
    icon: Circle,
    tone: TONE_OF_ENUM[getEnumTone(id)],
  };
  return {
    id,
    label: extra.label ?? resolveStatusLabel(id),
    count: extra.count,
    ...mark,
  };
}

/**
 * One value of a kind filter: the kind's name, icon and colour. `profile`
 * (a profile's `uiHints`) wins over the registry when the data has it.
 */
export function kindOption<K extends string>(
  id: K,
  extra: {
    count?: number | string | null;
    profile?: ProfileIdentityInput | null;
  } = {}
): FilterOption<K> {
  const identity = resolveObjectIdentity(id, extra.profile);
  return {
    id,
    label: identity.label,
    count: extra.count,
    icon: kindIcon(id, extra.profile),
    color: identity.color,
  };
}
