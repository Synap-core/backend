/**
 * What a pipeline view's read-only snapshot shows, from `flow.of` (the ONE read
 * of a kind's flow: its declared states in order, an exact count per state and
 * the first cards). Pod admin never decides a status list or its order: the
 * order is the lifecycle's own (`order`), the labels and counts are the pod's.
 *
 * The count is always exact; the cards are a capped sample, so `more` is the
 * count minus the cards shown, never a guess.
 */

export interface FlowCardLike {
  id: string;
  name: string | null;
}

export interface FlowStateLike {
  key: string;
  label: string;
  /** Declared order, from 0. */
  order: number;
  count: number;
  /** Things past the state's stuck rule; null = the state declares none. */
  stuck: number | null;
  /** done/lost states count only what entered within the window. */
  windowed: boolean;
  cards: FlowCardLike[];
}

export interface FlowLike {
  states: FlowStateLike[];
  /** Things in no declared state; never dropped. */
  unclassified: { count: number } | null;
  totals: { total: number };
  window: { days: number };
}

export interface SnapshotRow {
  key: string;
  label: string;
  count: number;
  /** Only when positive: zero stuck is not worth a mark. */
  stuck: number | null;
  /** The window a done/lost count covers; null for a live state. */
  windowDays: number | null;
  cards: FlowCardLike[];
  /** Things in the state that the capped cards do not show. */
  more: number;
}

export interface PipelineSnapshot {
  rows: SnapshotRow[];
  total: number;
  unclassified: number;
  /** Nothing anywhere: no thing in any state, none outside one. */
  empty: boolean;
}

/** How many cards a state shows; the rest is "+N more" and the app. */
export const SNAPSHOT_CARD_CAP = 3;

export function pipelineSnapshot(
  flow: FlowLike,
  cap: number = SNAPSHOT_CARD_CAP
): PipelineSnapshot {
  const rows = [...flow.states]
    .sort((a, b) => a.order - b.order)
    .map((state): SnapshotRow => {
      const cards = state.cards.slice(0, cap);
      return {
        key: state.key,
        label: state.label,
        count: state.count,
        stuck: state.stuck && state.stuck > 0 ? state.stuck : null,
        windowDays: state.windowed ? flow.window.days : null,
        cards,
        more: Math.max(0, state.count - cards.length),
      };
    });
  const unclassified = flow.unclassified?.count ?? 0;
  return {
    rows,
    total: flow.totals.total,
    unclassified,
    empty: flow.totals.total === 0 && unclassified === 0,
  };
}
