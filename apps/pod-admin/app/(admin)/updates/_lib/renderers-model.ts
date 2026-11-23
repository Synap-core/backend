/**
 * Pod updates' Renderers card: ONE pure function from what the pod answered
 * to what the card shows (`renderersCardView`): the mark, a short secondary
 * line, the quiet lines under it, ONE primary act and the ⋯ menu.
 *
 * Reads:
 *   - `renderers.status` (through `readRenderersStatus`, the object frame's
 *     parser): which bundle is installed;
 *   - `renderers.updates` (pod admins): what the pod's 10-minute pass last
 *     read: the newest version, why it waits, a hold, a refusal, a pause;
 *   - the bundle's last receipt (`packageUpdates.history`), for Undo.
 * Has-an-update is the ONE rule `packageHasUpdate`; a refusal is worded by
 * the ONE reason map below, whether the person's install or the pod's own
 * pass met it.
 *
 * Acts: Install is `marketplace.install` kind `renderer-bundle`; Update,
 * Undo, Pause and Resume are the package-updates doors.
 */
import {
  RENDERER_BUNDLE_HOLD_REASONS,
  RENDERER_BUNDLE_WAIT_REASONS,
  packageHasUpdate,
  type PackageUpdateReceipt,
  type RendererBundleUpdateState,
} from "@synap-core/types/package-updates";
import type { RenderersStatus } from "../../../_lib/object/content/use-object-renderer";
import { updateFailureOf } from "../../marketplace/updates/_lib/updates-model";
import type { en } from "./copy";

/** Synap's own renderer bundle (published from app-bases `renderer-bundles/`). */
export const SYNAP_RENDERERS_SLUG = "synap-renderers";

/** Why an install of Synap's renderers did not go through. */
export type RenderersRefusal =
  | "plan_required"
  | "pod_not_enrolled"
  | "no_control_plane"
  | "insecure_control_plane"
  | "pod_not_live"
  | "other_renderers"
  | "needs_newer_pod"
  | "failed";

/**
 * The pod's machine reason → the refusal this card words. Every
 * `renderer_bundle_*` code the pod's fetch can throw is mapped
 * (`renderers-model.test.ts` reads them from the pod's source).
 */
const REFUSAL_BY_REASON: Readonly<Record<string, RenderersRefusal>> = {
  renderer_bundle_plan_required: "plan_required",
  renderer_bundle_pod_not_enrolled: "pod_not_enrolled",
  renderer_bundle_no_control_plane: "no_control_plane",
  renderer_bundle_insecure_control_plane: "insecure_control_plane",
  renderer_bundle_pod_not_live: "pod_not_live",
  RENDERER_HOST_SET_TAKEN: "other_renderers",
  RENDERER_BUNDLE_REQUIRES_UNMET: "needs_newer_pod",
};

/** The machine reasons this card words (for the parity test). */
export const WORDED_REASONS: readonly string[] = Object.keys(REFUSAL_BY_REASON);

function refusalOfReason(code: unknown): RenderersRefusal {
  return (typeof code === "string" && REFUSAL_BY_REASON[code]) || "failed";
}

/** The refusal behind a failed install; anything untyped is `failed`. */
export function renderersRefusalOf(err: unknown): RenderersRefusal {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return refusalOfReason(data?.reasonCode);
}

/** What went wrong with Update, Undo or Pause, in the words it has. */
export type RenderersActFailure =
  RenderersRefusal | "conflict" | "expired" | "failed";

/** A failed act → its words: a typed refusal first, then the update doors'. */
export function renderersActFailureOf(err: unknown): RenderersActFailure {
  const refusal = renderersRefusalOf(err);
  if (refusal !== "failed") return refusal;
  const failure = updateFailureOf(err);
  return failure === "conflict" || failure === "expired" ? failure : "failed";
}

// ─── The wire ───────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);

/**
 * `renderers.updates` as pod admin reads it (the same narrowing as its
 * neighbour `readRenderersStatus`); null when the pod never read its control
 * plane, or the answer is not one this page knows (never a guessed "up to
 * date").
 */
export function readRenderersUpdates(
  data: unknown
): RendererBundleUpdateState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!isStr(d.slug)) return null;
  const refusal = d.refusal as Record<string, unknown> | null | undefined;
  const hold = d.hold as Record<string, unknown> | null | undefined;
  const holdReason = RENDERER_BUNDLE_HOLD_REASONS.find(
    (r) => r === hold?.reason
  );
  return {
    slug: d.slug,
    latestVersion: strOrNull(d.latestVersion),
    latestPublishedAt: strOrNull(d.latestPublishedAt),
    checkedAt: strOrNull(d.checkedAt),
    installedRetired: d.installedRetired === true,
    refusal:
      refusal && isStr(refusal.reasonCode) && isStr(refusal.at)
        ? {
            reasonCode: refusal.reasonCode,
            message: isStr(refusal.message) ? refusal.message : "",
            at: refusal.at,
          }
        : null,
    hold:
      hold && holdReason && isStr(hold.version) && isStr(hold.at)
        ? {
            version: hold.version,
            reason: holdReason,
            detail: isStr(hold.detail) ? hold.detail : "",
            at: hold.at,
          }
        : null,
    pausedAt: strOrNull(d.pausedAt),
    waitReason:
      RENDERER_BUNDLE_WAIT_REASONS.find((r) => r === d.waitReason) ?? null,
    applyAfter: strOrNull(d.applyAfter),
  };
}

// ─── The card ───────────────────────────────────────────────────────────────

export type RenderersCopyKey = keyof typeof en;

/** One line of words: a catalog key and its filled params. */
export interface RenderersLine {
  key: RenderersCopyKey;
  params?: Record<string, string>;
}

/** What this visit did, kept on the card until the next act or a reload. */
export type RenderersLast =
  | { kind: "refused"; refusal: RenderersRefusal; detail: string }
  | { kind: "proposed"; proposalId: string }
  | { kind: "installed" }
  | { kind: "undone" }
  | {
      kind: "act-failed";
      act: "update" | "undo" | "pause";
      failure: RenderersActFailure;
      detail: string;
    }
  | null;

/** How the pod answered `renderers.updates` and the receipt read. */
export type RenderersUpdatesRead =
  | { read: "ok"; state: RendererBundleUpdateState | null }
  | { read: "loading" }
  | { read: "failed" }
  /** Not a pod admin: the part is omitted. */
  | { read: "forbidden" };

export type RenderersPrimary =
  | { kind: "install" }
  | { kind: "open-request"; proposalId: string }
  | { kind: "update"; version: string }
  /** A door to this page's "How to update now" card. */
  | { kind: "update-pod" }
  | { kind: "undo"; receiptId: string; version: string }
  | { kind: "resume" };

export type RenderersOverflow = "reinstall" | "pause" | "resume";

export interface RenderersCardView {
  /** Absent on a healthy row. */
  mark: { kind: "unknown" | "stale"; label: RenderersLine } | null;
  /** Short: it is cut to one line on a phone. */
  secondary: RenderersLine;
  /** Quiet lines under the row: why it waits, what was done. */
  notes: RenderersLine[];
  /** A door after the notes: the Auto-update card on this page. */
  door: "auto-update" | null;
  primary: RenderersPrimary | null;
  overflow: RenderersOverflow[];
  /** A refusal on screen, as an ErrorNote. `byPassAt`: the pod's own try. */
  error: {
    line: RenderersLine;
    detail: string | null;
    byPassAt: string | null;
    enroll: boolean;
  } | null;
  /** The updates part: drawn, a read error with retry, or omitted. */
  updates: "ok" | "failed" | "omit";
  /** A filed request, with its door. */
  proposalId: string | null;
}

export interface RenderersCardInput {
  status: RenderersStatus;
  updates: RenderersUpdatesRead;
  /** The bundle's newest receipt, if any. */
  receipt: PackageUpdateReceipt | null;
  last: RenderersLast;
  now: number;
  /** How a date reads: until a future instant, since a past one. */
  when: { until: (iso: string) => string; since: (iso: string) => string };
}

const line = (
  key: RenderersCopyKey,
  params?: Record<string, string>
): RenderersLine => (params ? { key, params } : { key });

const REFUSED_KEY = (r: RenderersRefusal): RenderersCopyKey =>
  `renderers.refused.${r}` as const;

/** Why the newest version waits, in a line (null: the refusal says it). */
function waitLine(
  wait: string | null,
  applyAfter: string | null,
  input: RenderersCardInput
): RenderersLine | null {
  switch (wait) {
    case "soak":
      return applyAfter && Date.parse(applyAfter) > input.now
        ? line("renderers.update.soak", { when: input.when.until(applyAfter) })
        : line("renderers.update.soakShortly");
    case "auto_off":
      return line("renderers.update.autoOff");
    case "setting_unreadable":
      return line("renderers.update.settingUnreadable");
    case "paused":
      return line("renderers.update.paused");
    case "requires":
      return line("renderers.update.requires");
    case "kit":
      return line("renderers.update.kit");
    case "undone":
      return line("renderers.update.undone");
    case "failed":
      return line("renderers.update.failed");
    case "frozen":
      return line("renderers.update.frozen");
    case "no_owner":
      return line("renderers.update.noOwner");
    default:
      return null;
  }
}

/** The ErrorNote for this visit's failed act, if any. */
function actError(last: RenderersLast): RenderersCardView["error"] {
  if (last?.kind === "refused") {
    return {
      line: line(REFUSED_KEY(last.refusal)),
      detail: last.detail,
      byPassAt: null,
      enroll: last.refusal === "pod_not_enrolled",
    };
  }
  if (last?.kind !== "act-failed") return null;
  const f = last.failure;
  const key: RenderersCopyKey =
    f === "conflict"
      ? last.act === "undo"
        ? "renderers.undo.conflict"
        : "renderers.update.conflict"
      : f === "expired"
        ? "renderers.undo.expired"
        : f === "failed"
          ? last.act === "undo"
            ? "renderers.undo.failed"
            : last.act === "pause"
              ? "renderers.pause.failed"
              : "renderers.update.failedNow"
          : REFUSED_KEY(f);
  return {
    line: line(key),
    detail: last.detail,
    byPassAt: null,
    enroll: f === "pod_not_enrolled",
  };
}

/**
 * (what the pod answered, what this visit did) → the card. One primary per
 * state; Reinstall is a repair act in ⋯, never beside an Update (both would
 * install the newest version, and only Update keeps a receipt and Undo).
 */
export function renderersCardView(
  input: RenderersCardInput
): RenderersCardView {
  const { status, updates, receipt, last, now } = input;
  const bundle = status.bundle;
  const proposalId = last?.kind === "proposed" ? last.proposalId : null;
  const state = updates.read === "ok" ? updates.state : null;
  const ours = state?.slug === SYNAP_RENDERERS_SLUG ? state : null;
  const updatesPart: RenderersCardView["updates"] =
    updates.read === "failed"
      ? "failed"
      : updates.read === "ok"
        ? "ok"
        : "omit";

  // The pod's own refusal (the pass), when this visit has none of its own.
  const passError: RenderersCardView["error"] = ours?.refusal
    ? {
        line: line(REFUSED_KEY(refusalOfReason(ours.refusal.reasonCode))),
        detail: ours.refusal.message || null,
        byPassAt: ours.refusal.at,
        enroll: refusalOfReason(ours.refusal.reasonCode) === "pod_not_enrolled",
      }
    : null;
  const error = actError(last) ?? passError;

  if (!bundle) {
    // The pass's own first install may have been held (it needs a newer pod,
    // or it failed): said as the install's refusal.
    const hold = ours?.hold;
    const heldError: RenderersCardView["error"] =
      !error && hold && (hold.reason === "requires" || hold.reason === "failed")
        ? {
            line: line(
              REFUSED_KEY(
                hold.reason === "requires" ? "needs_newer_pod" : "failed"
              )
            ),
            detail: hold.detail || null,
            byPassAt: hold.at,
            enroll: false,
          }
        : null;
    return {
      mark: {
        kind: "unknown",
        label: line("renderers.state.none"),
      },
      secondary: line("renderers.none"),
      notes: [],
      door: null,
      // A request already filed: its door, never a second Install.
      primary: proposalId
        ? { kind: "open-request", proposalId }
        : { kind: "install" },
      overflow: [],
      error: error ?? heldError,
      updates: "omit",
      proposalId,
    };
  }

  if (bundle.slug !== SYNAP_RENDERERS_SLUG) {
    return {
      mark: { kind: "unknown", label: line("renderers.state.other") },
      secondary: line("renderers.other", {
        slug: bundle.slug,
        version: bundle.version,
      }),
      notes: [line("renderers.other.why")],
      door: null,
      primary: null,
      overflow: [],
      error,
      updates: "omit",
      proposalId: null,
    };
  }

  const installed = bundle.version;
  const paused = !!ours?.pausedAt;
  const latest = ours?.latestVersion ?? null;
  const available =
    updatesPart === "ok" && latest && packageHasUpdate(installed, latest)
      ? latest
      : null;
  const pauseItem: RenderersOverflow[] =
    updatesPart === "ok" ? [paused ? "resume" : "pause"] : [];
  const notes: RenderersLine[] = [];
  if (last?.kind === "undone") notes.push(line("renderers.undone"));

  if (available) {
    const hold = ours?.hold?.version === available ? ours.hold.reason : null;
    const wait = paused ? "paused" : (hold ?? ours?.waitReason ?? null);
    const waits = waitLine(wait, ours?.applyAfter ?? null, input);
    if (waits) notes.push(waits);
    const needsPod = wait === "requires";
    return {
      mark: needsPod
        ? { kind: "stale", label: line("renderers.state.needsPod") }
        : paused
          ? { kind: "unknown", label: line("renderers.state.paused") }
          : { kind: "stale", label: line("renderers.state.available") },
      secondary: line("renderers.update.available", { version: available }),
      notes,
      door: wait === "auto_off" ? "auto-update" : null,
      primary: proposalId
        ? { kind: "open-request", proposalId }
        : needsPod
          ? { kind: "update-pod" }
          : wait === "frozen"
            ? null
            : { kind: "update", version: available },
      overflow: pauseItem,
      error,
      updates: updatesPart,
      proposalId,
    };
  }

  const undoable =
    receipt &&
    receipt.slug === SYNAP_RENDERERS_SLUG &&
    !receipt.undoneAt &&
    receipt.fromVersion &&
    receipt.toVersion === installed &&
    now < Date.parse(receipt.undoUntil)
      ? receipt
      : null;
  if (undoable && updatesPart === "ok") {
    notes.push(
      line(
        undoable.source === "automatic"
          ? "renderers.updated.auto"
          : "renderers.updated.person",
        { version: installed, when: input.when.since(undoable.appliedAt) }
      )
    );
  }
  const version = line(
    last?.kind === "installed"
      ? "renderers.version.justInstalled"
      : "renderers.version",
    { version: installed }
  );
  return {
    mark: paused
      ? { kind: "unknown", label: line("renderers.state.paused") }
      : null,
    secondary: version,
    notes,
    door: null,
    primary: proposalId
      ? { kind: "open-request", proposalId }
      : undoable && updatesPart === "ok"
        ? { kind: "undo", receiptId: undoable.id, version: installed }
        : paused
          ? { kind: "resume" }
          : null,
    overflow: [
      "reinstall",
      ...(paused ? [] : pauseItem),
    ] as RenderersOverflow[],
    error,
    updates: updatesPart,
    proposalId,
  };
}
