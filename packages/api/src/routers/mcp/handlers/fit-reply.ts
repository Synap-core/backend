/**
 * Fit a machine-read reply under the MCP reply cap WITHOUT cutting it.
 *
 * WHY: the reply cap (`reply-cap.ts`) turns any reply over 16,000 characters
 * into `{truncated, head}`: honest, but a program cannot parse a head. On
 * 2026-11-09 the founder's Mac worker could not read a lean session (18,987
 * characters) nor a room (22,886) and stalled (finding 69fdd2e6). A read a
 * program depends on (`synap_get_session` lean, `synap_get_thread_context`)
 * fits ITSELF instead: it stays valid JSON, keeps the head of every list, and
 * says what it left out.
 *
 * How: while the reply (as `ok()` writes it) is over the budget, the largest
 * list of 2+ items keeps its first items (it drops about what the excess
 * needs), else the largest long string keeps its first half. Each step shrinks the reply, so it ends; `fit.omitted`
 * names each list and how many items it lost, `fit.clipped` each string.
 */
import { REPLY_CAP_CHARS } from "../reply-cap.js";
import { replyJson, UntrustedText } from "./shared.js";

/**
 * The budget a fitted reply aims for: the cap less room for what `ok()` adds
 * (the `link`) and the `fit` notice itself.
 */
export const FIT_BUDGET_CHARS = REPLY_CAP_CHARS - 1_000;

/** A string shorter than this is never clipped (ids, dates, labels). */
const MIN_CLIP_CHARS = 240;

/** At most this many shrink steps (each one halves something). */
const MAX_STEPS = 400;

export interface FitNotice {
  /** The budget the reply was fitted to. */
  budget: number;
  /** Lists that kept only their first items: path → how many were left out. */
  omitted: Record<string, number>;
  /** Strings that kept only their start (ending in "…"). */
  clipped: string[];
  how: string;
}

type Node = unknown;
type Slot = { get: () => Node; set: (v: Node) => void; path: string };

/** A copy of the plain objects and arrays; every other value is shared. */
function copy(v: Node): Node {
  if (Array.isArray(v)) return v.map(copy);
  if (
    v &&
    typeof v === "object" &&
    Object.getPrototypeOf(v) === Object.prototype
  ) {
    const out: Record<string, Node> = {};
    for (const [k, x] of Object.entries(v)) out[k] = copy(x);
    return out;
  }
  return v;
}

function slots(root: { v: Node }): Slot[] {
  const out: Slot[] = [];
  const walk = (
    holder: Record<string, Node> | Node[],
    key: string | number,
    path: string
  ) => {
    const get = () => (holder as Record<string, Node>)[key as string];
    const set = (x: Node) => {
      (holder as Record<string, Node>)[key as string] = x;
    };
    out.push({ get, set, path });
    const v = get();
    if (Array.isArray(v)) v.forEach((_, i) => walk(v, i, `${path}[${i}]`));
    else if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    )
      for (const k of Object.keys(v))
        walk(v as Record<string, Node>, k, path ? `${path}.${k}` : k);
  };
  walk(root as unknown as Record<string, Node>, "v", "");
  return out;
}

const textOf = (v: Node): string | null =>
  typeof v === "string" ? v : v instanceof UntrustedText ? v.text : null;

/** A list's path without its indexes: `room.last[2].x` → `room.last[].x`. */
const listPath = (path: string) => path.replace(/\[\d+\]/g, "[]");

/**
 * `data` fitted under `budget` characters as `ok()` writes it, with a `fit`
 * notice when anything was left out. `data` itself is never changed. Within
 * budget, `data` is returned as it is (no notice).
 */
export function fitReply<T extends Record<string, unknown>>(
  data: T,
  opts: { budget?: number; how?: string } = {}
): T & { fit?: FitNotice } {
  const budget = opts.budget ?? FIT_BUDGET_CHARS;
  if (replyJson(data).length <= budget) return data;
  const root = { v: copy(data) };
  const omitted: Record<string, number> = {};
  const clipped = new Set<string>();
  for (
    let step = 0;
    step < MAX_STEPS && replyJson(root.v).length > budget;
    step++
  ) {
    let best: { slot: Slot; size: number; kind: "list" | "text" } | null = null;
    for (const slot of slots(root)) {
      if (!slot.path) continue;
      const v = slot.get();
      const text = textOf(v);
      const kind =
        Array.isArray(v) && v.length > 1
          ? "list"
          : text !== null && text.length >= MIN_CLIP_CHARS
            ? "text"
            : null;
      if (!kind) continue;
      const size = replyJson(v).length;
      if (!best || size > best.size) best = { slot, size, kind };
    }
    if (!best) break;
    const v = best.slot.get();
    if (best.kind === "list") {
      const list = v as Node[];
      // Drop about as many items as the excess needs (each item weighs the
      // list's average), at least one, keeping at least one.
      const excess = replyJson(root.v).length - budget;
      const perItem = best.size / list.length;
      const drop = Math.min(
        list.length - 1,
        Math.max(1, Math.ceil(excess / Math.max(1, perItem)))
      );
      const keep = list.length - drop;
      const p = listPath(best.slot.path);
      omitted[p] = (omitted[p] ?? 0) + (list.length - keep);
      best.slot.set(list.slice(0, keep));
    } else {
      const text = textOf(v)!;
      const cut = `${text.slice(0, Math.max(MIN_CLIP_CHARS - 1, Math.floor(text.length / 2)))}…`;
      best.slot.set(
        v instanceof UntrustedText ? new UntrustedText(cut, v.source) : cut
      );
      clipped.add(best.slot.path);
    }
  }
  return {
    ...(root.v as T),
    fit: {
      budget,
      omitted,
      clipped: [...clipped],
      how:
        opts.how ??
        "This reply was fitted under the reply cap: each list named in `omitted` kept its first items, each string in `clipped` its start. Read one object by its id for the rest.",
    },
  };
}
