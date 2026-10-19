/**
 * A THING's history — the thing page's History section (work model L8), one
 * builder for web and relay.
 *
 * Two sources, merged newest-first, then day-grouped and batched by the ONE
 * Happened rule ({@link batchHappenedItems}):
 *
 *   1. lifecycle transitions (`entity.transition.completed`, the moveStatus
 *      door's one event) — "Moved from Lead to Qualified", a fact of its own
 *      that never batches;
 *   2. every other event logged on the thing (record changes, through
 *      {@link happenedItemOfEvent}), plus any ledger rows the host read.
 *
 * Read with `events.search({ subjectType: "entity", subjectId })`; the
 * transition rows come back in the same list — no second read is needed.
 * A kind's move is logged ONCE (the dual `entity.update` emit is fan-out
 * only, never a log row), so nothing here de-duplicates.
 *
 * The scope of such a list is the pod (`{ kind: "pod" }`): a row's source is
 * a workspace / project / track / session, never the thing itself, so an
 * entity lens scope would hide nothing more.
 */
import type { ActivityRow } from "../activity/index.js";
import {
  resolveActionLabel,
  resolveObjectNoun,
  resolveStatusLabel,
} from "../vocabulary/index.js";
import {
  batchHappenedItems,
  happenedItemOfEvent,
  type HappenedDay,
  type HappenedEntry,
  type HappenedItem,
  type LoggedEvent,
} from "./rows.js";

/** The one event every status move logs (`@synap/events` emitter). */
export const LIFECYCLE_TRANSITION_EVENT = "entity.transition.completed";

/**
 * The words for a status key of a lifecycle (`role` = the role slug, null for
 * the kind's own). The host passes the declaration's `lifecycleOptionLabel`;
 * absent, the shared vocabulary speaks.
 */
export type StatusLabelOf = (key: string, role: string | null) => string;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A transition log row as a Happened item, or null when it is not one. */
export function happenedItemOfTransition(
  e: LoggedEvent,
  labelOf?: StatusLabelOf
): HappenedItem | null {
  if (e.type !== LIFECYCLE_TRANSITION_EVENT) return null;
  const at = new Date(e.timestamp);
  if (!Number.isFinite(at.getTime())) return null;
  const data =
    e.data && typeof e.data === "object" && !Array.isArray(e.data)
      ? (e.data as Record<string, unknown>)
      : {};
  const to = str(data.to);
  if (!to) return null;
  const from = str(data.from);
  const role = str(data.role);
  const words = (key: string) =>
    labelOf ? labelOf(key, role) : resolveStatusLabel(key);
  const verb = resolveActionLabel("move", "past");
  // A role's move names the role first ("Lead · Moved to Engaged"): the
  // noun keeps its own casing, never lowercased at a call site.
  const subject = role ? `${resolveObjectNoun(role)} · ` : "";
  const path = from
    ? ` from ${words(from)} to ${words(to)}`
    : ` to ${words(to)}`;
  const reason = str(data.reason);
  const objectKind = role ?? str(data.profileSlug) ?? "entity";
  return {
    kind: "data",
    event: {
      id: e.id,
      action: "move",
      objectKind,
      door: e.subjectId ? { kind: "entity", id: e.subjectId } : null,
      occurredAt: at.toISOString(),
      origin: null,
      line: {
        action: "move",
        objectKind,
        name: words(to),
        detail: reason,
        failed: false,
        text: `${subject}${verb}${path}${reason ? ` · ${reason}` : ""}`,
      },
    },
  };
}

function itemTime(item: HappenedItem): number {
  return new Date(
    item.kind === "ledger" ? item.row.occurredAt : item.event.occurredAt
  ).getTime();
}

/**
 * A record change the event could only call "entity" takes the thing's own
 * kind. Its door stays an entity door (that is how the thing opens); only the
 * noun changes. Anything already named by the event keeps its name.
 */
function namedByOwnKind(
  item: HappenedItem | null,
  ownKind: string | null
): HappenedItem | null {
  if (!item || !ownKind || item.kind !== "data" || item.event.line) return item;
  if (item.event.objectKind !== "entity") return item;
  return { ...item, event: { ...item.event, objectKind: ownKind } };
}

/**
 * The thing's History: its logged events (transitions included) and any
 * ledger rows, newest first, day-grouped and batched. Events neither rule
 * can read (governance phases, unknown families) are dropped, never drawn
 * raw.
 */
export function entityHappened(
  input: {
    events: readonly LoggedEvent[];
    ledger?: readonly ActivityRow[];
    labelOf?: StatusLabelOf;
    /**
     * The thing's own kind (its `profileSlug`). A record change ON the thing
     * is named by it ("Updated lead"). The pod's `entities.update.completed`
     * carries the entity ROW, which has no `profileSlug`, so without this every
     * edit read "Updated entity" on the thing's own page (critique L P0-3).
     */
    profileSlug?: string | null;
  },
  opts: { timeZone: string; now?: Date }
): HappenedDay<HappenedEntry>[] {
  const items: HappenedItem[] = [];
  const ownKind = input.profileSlug?.trim() || null;
  for (const e of input.events) {
    const item =
      e.type === LIFECYCLE_TRANSITION_EVENT
        ? happenedItemOfTransition(e, input.labelOf)
        : namedByOwnKind(happenedItemOfEvent(e), ownKind);
    if (item) items.push(item);
  }
  for (const row of input.ledger ?? []) items.push({ kind: "ledger", row });
  items.sort((a, b) => itemTime(b) - itemTime(a));
  return batchHappenedItems(items, opts);
}
