/**
 * A graph that STOPPED part-way, read from the pod's own record of it.
 *
 * When a capture graph's op throws, what landed before it stays (outside a
 * plan there is no rollback). The pod now stamps exactly that on the
 * proposal: `data.materialized` carries what landed (`byOp`, the shape a
 * complete run stamps) plus `opCount`, `failedOp`, `notRun` and `skipped`.
 * The status stays `approval_failed`, so "N of M filed" is derived from the
 * record here, never from the status.
 *
 * Before (proposal e8fc00d6, 2026-10-22) the page said only "Profile not
 * found: trend": the four records that HAD been filed were invisible, and the
 * wording meant "what it points at no longer exists".
 *
 * Pure and defensive: the input is JSONB from the wire, so every field is
 * read by shape. Returns null for anything that is not a stopped graph (the
 * failure card then shows the pod's sentence alone, as before).
 */

import type { proposalPageT } from "./copy";

export interface StoppedItem {
  key: string;
  label: string;
  /** A record the run filed or linked; absent for a link between two. */
  entityId?: string;
  /** The record already existed: the run linked it, it did not create it. */
  linked?: boolean;
}

export interface StoppedGraphReport {
  /** Every op the run was given. */
  total: number;
  /** Ops that landed. */
  filed: number;
  /** 1 when the op that threw is known, else 0. */
  couldNot: number;
  notTried: number;
  landed: StoppedItem[];
  failed?: StoppedItem & { reason: string };
  /** The missing kind, when that is why it stopped (for the named sentence). */
  kindMissing?: KindMissingView;
  skipped: Array<StoppedItem & { reason: string }>;
  notRun: StoppedItem[];
}

export interface KindMissingView {
  kind: string;
  space?: string;
  elsewhere: string[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `<sourceRef>-><targetRef>:<type>` — the key the pod gives a relation op. */
function parseEdgeKey(key: string): { from: string; to: string } | null {
  const arrow = key.indexOf("->");
  const colon = key.lastIndexOf(":");
  if (arrow <= 0 || colon <= arrow + 2) return null;
  return { from: key.slice(0, arrow), to: key.slice(arrow + 2, colon) };
}

export function stoppedGraphReport(input: {
  data: unknown;
  graph?: unknown;
}): StoppedGraphReport | null {
  const data = rec(input.data);
  const materialized = rec(data?.materialized);
  const total = materialized?.opCount;
  if (typeof total !== "number" || total <= 0) return null;

  // ref → the title a person knows it by: the review graph first (it resolves
  // a linked record's real title), then the op's own.
  const titleByRef = new Map<string, string>();
  for (const op of arr(data?.operations)) {
    const o = rec(op);
    const ref = str(o?.ref);
    const title = str(o?.title) ?? str(o?.name);
    if (ref && title) titleByRef.set(ref, title);
  }
  for (const e of arr(rec(input.graph)?.entities)) {
    const o = rec(e);
    const ref = str(o?.ref);
    const title = str(o?.title);
    if (ref && title) titleByRef.set(ref, title);
  }
  const labelOf = (key: string, title?: string): string => {
    const edge = parseEdgeKey(key);
    if (edge) {
      return `${titleByRef.get(edge.from) ?? edge.from} → ${
        titleByRef.get(edge.to) ?? edge.to
      }`;
    }
    return titleByRef.get(key) ?? title ?? key;
  };
  const itemOf = (v: unknown): StoppedItem | null => {
    const o = rec(v);
    const key = str(o?.key);
    if (!o || !key) return null;
    return { key, label: labelOf(key, str(o.title)) };
  };

  const landed: StoppedItem[] = [];
  for (const [key, entry] of Object.entries(rec(materialized?.byOp) ?? {})) {
    const e = rec(entry);
    if (!e || e.revertedAt) continue;
    const entityId = str(e.entityId);
    landed.push({
      key,
      label: labelOf(key),
      ...(entityId ? { entityId } : {}),
      ...(e.linked === true ? { linked: true } : {}),
    });
  }

  const failedItem = itemOf(materialized?.failedOp);
  const failedReason = str(rec(materialized?.failedOp)?.reason);
  const failed =
    failedItem && failedReason
      ? { ...failedItem, reason: failedReason }
      : undefined;
  const notRun = arr(materialized?.notRun)
    .map(itemOf)
    .filter((i): i is StoppedItem => i !== null);
  const skipped = arr(materialized?.skipped).flatMap((s) => {
    const item = itemOf(s);
    const reason = str(rec(s)?.reason);
    return item && reason ? [{ ...item, reason }] : [];
  });

  const km = rec(rec(data?.failure)?.kindMissing);
  const kind = str(km?.kindName) ?? str(km?.profileSlug);
  const kindMissing: KindMissingView | undefined =
    rec(data?.failure)?.errorClass === "kind_missing" && kind
      ? {
          kind,
          ...(str(km?.workspaceName) ? { space: str(km?.workspaceName) } : {}),
          elsewhere: arr(km?.foundIn)
            .map((f) => str(rec(f)?.name))
            .filter((n): n is string => !!n),
        }
      : undefined;

  const couldNot = failed ? 1 : 0;
  return {
    total,
    filed: Math.max(0, total - couldNot - notRun.length - skipped.length),
    couldNot,
    notTried: notRun.length,
    landed,
    ...(failed ? { failed } : {}),
    ...(kindMissing ? { kindMissing } : {}),
    skipped,
    notRun,
  };
}

type T = ReturnType<typeof proposalPageT>;

/** "4 of 11 items filed · 1 could not be filed · 6 not tried". */
export function stoppedHeader(report: StoppedGraphReport, t: T): string {
  return [
    t("stopped.filed", { filed: report.filed, total: report.total }),
    ...(report.couldNot > 0
      ? [t("stopped.couldNot", { n: report.couldNot })]
      : []),
    ...(report.notTried > 0
      ? [t("stopped.notTried", { n: report.notTried })]
      : []),
  ].join(" · ");
}

/** "Kind “Trend” isn’t available in Foundation. It exists in Ecosystem." */
export function kindMissingLine(view: KindMissingView, t: T): string {
  const here = view.space
    ? t("stopped.kindMissing", { kind: view.kind, space: view.space })
    : t("stopped.kindMissingHere", { kind: view.kind });
  const there =
    view.elsewhere.length > 0
      ? t("stopped.kindElsewhere", {
          spaces: joinNames(view.elsewhere, t("stopped.and")),
        })
      : t("stopped.kindNowhere");
  return `${here} ${there}`;
}

/** "Ecosystem", "Ecosystem and Studio", "A, B and C". */
export function joinNames(names: string[], and: string): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}
