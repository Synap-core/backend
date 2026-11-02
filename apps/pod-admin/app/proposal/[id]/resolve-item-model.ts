/**
 * The waiting items of a graph that stopped part-way, with the choices the
 * pod offers for each (`proposals.resolveOptions`), as rows the failure card
 * draws. A press sends the choice's `action` back to `proposals.resolveItem`
 * unchanged: the pod files that ONE item (and the links that need it), then
 * files what never ran. Nothing is filed twice.
 *
 * Live 2026-10-22 (proposal e8fc00d6): "4 of 5 items filed", the fifth a
 * Trend whose kind exists only in Ecosystem. The card now offers "File it in
 * Ecosystem" (recommended: same kind, nothing new), "Make Trend available in
 * Foundation", "File it as Research", "Skip this item".
 *
 * Pure and defensive: the input is the wire answer, read by shape. Rows are
 * the items that wait for the person (failed, or held for a review); the
 * links that only follow an item are not rows of their own. A choice the pod
 * marks unavailable is not drawn (no dead button), except a scope change
 * already waiting for its review, which the row says in words.
 */

import type { proposalPageT } from "./copy";

/** What `resolveItem` takes as `action` — echoed from the option. */
export type ResolveAction =
  | { type: "file_in_workspace"; workspaceId: string }
  | { type: "use_kind"; profileSlug: string }
  | { type: "skip" }
  | { type: "create_kind" }
  | { type: "widen_kind_scope"; profileId: string };

export interface ResolveChoice {
  key: string;
  label: string;
  /** Why this one is recommended, in a few words. */
  hint?: string;
  recommended: boolean;
  action: ResolveAction;
}

export interface ResolveRow {
  itemRef: string;
  title: string;
  state: "failed" | "held" | "not_run";
  /** "Its 3 links are filed with it." */
  dependentsNote?: string;
  /** A held item: what it waits for. */
  heldNote?: string;
  choices: ResolveChoice[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type T = ReturnType<typeof proposalPageT>;

function readAction(v: unknown): ResolveAction | null {
  const a = rec(v);
  switch (a?.type) {
    case "file_in_workspace":
      return str(a.workspaceId)
        ? { type: "file_in_workspace", workspaceId: str(a.workspaceId)! }
        : null;
    case "use_kind":
      return str(a.profileSlug)
        ? { type: "use_kind", profileSlug: str(a.profileSlug)! }
        : null;
    case "widen_kind_scope":
      return str(a.profileId)
        ? { type: "widen_kind_scope", profileId: str(a.profileId)! }
        : null;
    case "skip":
      return { type: "skip" };
    case "create_kind":
      return { type: "create_kind" };
    default:
      return null;
  }
}

function choiceOf(o: Rec, t: T): ResolveChoice | null {
  if (o.available === false) return null;
  const action = readAction(o.action);
  if (!action) return null;
  const kind = str(o.kindName) ?? "";
  const recommended = o.recommended === true;
  let label: string;
  let hint: string | undefined;
  switch (o.kind) {
    case "file_here_now":
      label = t("resolve.fileHereNow", { kind });
      break;
    case "file_in_workspace":
      label = t("resolve.fileIn", { space: str(o.workspaceName) ?? "" });
      hint = t("resolve.fileInHint", { kind });
      break;
    case "widen_kind_scope":
      label = t("resolve.widen", {
        kind,
        space: str(o.intoWorkspaceName) ?? "",
      });
      hint = t("resolve.widenHint");
      break;
    case "use_kind":
      label = t("resolve.useKind", { kind });
      break;
    case "retry":
      label = t("resolve.retry");
      break;
    case "skip":
      label = t("resolve.skip");
      break;
    default:
      return null;
  }
  const key =
    action.type === "file_in_workspace"
      ? `${o.kind}:${action.workspaceId}`
      : action.type === "use_kind"
        ? `${o.kind}:${action.profileSlug}`
        : action.type === "widen_kind_scope"
          ? `${o.kind}:${action.profileId}`
          : String(o.kind);
  return { key, label, ...(hint ? { hint } : {}), recommended, action };
}

/** The rows to draw, waiting items first as the pod ordered them. */
export function resolveRows(answer: unknown, t: T): ResolveRow[] {
  const a = rec(answer);
  if (a?.resolvable !== true) return [];
  const items = arr(a.items)
    .map(rec)
    .filter((i): i is Rec => !!i);
  // The items that wait for the person; if none (the run stopped between two
  // steps), the first record that never ran is the way to continue.
  let waiting = items.filter((i) => i.state === "failed" || i.state === "held");
  if (waiting.length === 0) {
    const first = items.find((i) => i.op === "create_entity");
    waiting = first ? [first] : [];
  }
  return waiting.flatMap((i) => {
    const itemRef = str(i.itemRef);
    if (!itemRef) return [];
    const options = arr(i.options)
      .map(rec)
      .filter((o): o is Rec => !!o);
    const choices = options
      .map((o) => choiceOf(o, t))
      .filter((c): c is ResolveChoice => c !== null);
    // Recommended first, "skip" last, the pod's order kept otherwise.
    const rank = (c: ResolveChoice) =>
      c.recommended ? 0 : c.action.type === "skip" ? 2 : 1;
    choices.sort((x, y) => rank(x) - rank(y));
    const dependents = arr(i.dependents).length;
    const state =
      i.state === "held" ? "held" : i.state === "failed" ? "failed" : "not_run";
    const pendingWiden = options.some(
      (o) =>
        o.kind === "widen_kind_scope" &&
        o.available === false &&
        o.unavailableReason === "review_pending"
    );
    const km = rec(i.kindMissing);
    const kindName = str(km?.kindName) ?? str(km?.profileSlug) ?? "";
    return [
      {
        itemRef,
        title: str(i.title) ?? itemRef,
        state,
        ...(dependents > 0
          ? { dependentsNote: t("resolve.dependents", { n: dependents }) }
          : {}),
        ...(state === "held"
          ? {
              heldNote: pendingWiden
                ? t("resolve.heldWiden", {
                    kind: kindName,
                    space: str(km?.workspaceName) ?? "",
                  })
                : t("resolve.held"),
            }
          : {}),
        choices,
      },
    ];
  });
}

/** The toast after a resolution, from `resolveItem`'s answer. */
export function resolvedToast(
  result: unknown,
  t: T
): { title: string; color: "success" | "warning" } {
  const r = rec(result);
  if (r?.complete === true) {
    return { title: t("resolve.done.complete"), color: "success" };
  }
  const waiting = typeof r?.waiting === "number" ? r.waiting : 0;
  switch (r?.outcome) {
    case "held":
      return { title: t("resolve.done.held"), color: "success" };
    case "failed":
      return { title: t("resolve.done.failedAgain"), color: "warning" };
    case "skipped":
      return {
        title: t("resolve.done.skipped", { n: waiting }),
        color: "success",
      };
    default:
      return {
        title: t("resolve.done.filed", { n: waiting }),
        color: waiting > 0 ? "warning" : "success",
      };
  }
}
