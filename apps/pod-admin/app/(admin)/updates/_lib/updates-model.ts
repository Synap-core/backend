/**
 * Updates — the pure shaping of `GET /api/pod-updates` for the page and for
 * Home's "Needs you" row. No React, no fetch: the wire is narrowed here once
 * (a malformed body is `null`, never a guessed default) and every sentence the
 * owner reads is decided here, so the tests pin the words.
 *
 * Wire shape: `apps/api/src/routers/pod-updates.ts` (+ `pod-updates/index.ts`).
 * The engine (`synap update`) writes the outcome; this app only reads it.
 */

import type { StatusKind } from "../../components/status-pill";

export type UpdateChannel = "stable" | "fast";

export const UPDATE_CHANNELS: ReadonlyArray<{
  id: UpdateChannel;
  label: string;
  description: string;
  /** What choosing it means for the pod, in one line. */
  consequence: string;
}> = [
  {
    id: "stable",
    label: "Stable",
    description: "Tagged releases",
    consequence:
      "Gets tagged releases only — fewer updates, each one more settled.",
  },
  {
    id: "fast",
    label: "Fast",
    description: "Every green main build",
    consequence:
      "Gets every green build of main — new things sooner, more often.",
  },
];

export interface UpdateSettings {
  auto: boolean;
  channel: UpdateChannel;
}

/** The engine's own outcome metadata (`PodUpdateOutcome` on the pod). */
export interface UpdateOutcome {
  status: string;
  from: string | null;
  to: string | null;
  at: string | null;
  reason: string | null;
  dbRestored: boolean;
}

export type LastUpdate =
  /** No update has ever been recorded here. */
  | { kind: "none" }
  /** The record exists but could not be read: not the same as "none". */
  | { kind: "unreadable" }
  | { kind: "recorded"; outcome: UpdateOutcome };

export interface PodUpdatesView {
  settings: UpdateSettings;
  canEdit: boolean;
  lastUpdate: LastUpdate;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isChannel(v: unknown): v is UpdateChannel {
  return v === "stable" || v === "fast";
}

/**
 * The page's view from a response body, or null when the body is not the
 * contract (an old pod, a proxy error page). `settings: null` — the pod could
 * not read its own setting — is also null: the default must never be shown as
 * the owner's choice.
 */
export function parsePodUpdates(body: unknown): PodUpdatesView | null {
  const b = obj(body);
  const settings = obj(b?.settings);
  if (!b || !settings) return null;
  if (typeof settings.auto !== "boolean" || !isChannel(settings.channel)) {
    return null;
  }
  const last = obj(b.lastUpdate);
  let lastUpdate: LastUpdate;
  if (last?.read === "ok") {
    const o = obj(last.outcome);
    const status = strOrNull(o?.status);
    if (!o || !status) {
      lastUpdate = { kind: "unreadable" };
    } else {
      lastUpdate = {
        kind: "recorded",
        outcome: {
          status,
          from: strOrNull(o.from),
          to: strOrNull(o.to),
          at: strOrNull(o.at),
          reason: strOrNull(o.reason),
          dbRestored: o.dbRestored === true,
        },
      };
    }
  } else if (last?.read === "absent") {
    lastUpdate = { kind: "none" };
  } else {
    lastUpdate = { kind: "unreadable" };
  }
  return {
    settings: { auto: settings.auto, channel: settings.channel },
    canEdit: b.canEdit === true,
    lastUpdate,
  };
}

// ─── The last outcome, in words ──────────────────────────────────────────────

export type OutcomeToken =
  | "applied"
  | "up_to_date"
  | "rolled_back"
  | "rollback_failed"
  | "failed"
  | "aborted"
  | "other";

export interface OutcomeView {
  token: OutcomeToken;
  kind: StatusKind;
  label: string;
  /** One plain sentence: what happened and where the pod is now. */
  sentence: string;
  /** The recorded reason in plain words, when there is one. */
  reason: string | null;
  /** True when the update did not land — Home raises it. */
  didNotLand: boolean;
}

const REASON_WORDS: ReadonlyArray<[RegExp, string]> = [
  [
    /^manifest fetch failed/,
    "The new release's details couldn't be downloaded.",
  ],
  [/^deploy bundle invalid/, "The new release's files weren't valid."],
  [/^invalid manifest/, "The new release was refused as invalid."],
  [
    /^below minFrom/,
    "This pod has to update to an earlier release first, then to this one.",
  ],
  [/^not enough disk/, "There wasn't enough free disk space."],
  [
    /^compose preflight failed/,
    "The pre-update check of the pod's setup failed.",
  ],
  [/^image pull failed/, "The new release's images couldn't be downloaded."],
  [/^from-source build failed/, "Building the update from source failed."],
  [/^interrupted/, "The update was interrupted part-way."],
  [
    /^installing the release's deploy files failed/,
    "Installing the new release's files failed.",
  ],
  [
    /^writing the release image pins failed/,
    "Setting up the new release's images failed.",
  ],
  [/^pod-agent misconfigured/, "The pod's agent was misconfigured."],
  [
    /^kratos config generation failed/,
    "Setting up sign-in for the new release failed.",
  ],
  [/^Ory database bootstrap failed/, "Preparing the sign-in databases failed."],
  [/migration failed/, "A database change in the new release failed."],
  [
    /failed its canary health check/,
    "The new version didn't pass its health check.",
  ],
  [
    /unhealthy after the swap/,
    "The new version became unhealthy once it took over.",
  ],
  [
    /^some services failed to start/,
    "Some services didn't start on the new release.",
  ],
  [
    /^post-update verification failed/,
    "The final check after the update failed.",
  ],
];

/** The engine's fixed reason string as a sentence; the string itself when unknown. */
export function reasonInWords(reason: string | null): string | null {
  if (!reason) return null;
  for (const [pattern, words] of REASON_WORDS) {
    if (pattern.test(reason)) return words;
  }
  return reason;
}

function route(o: UpdateOutcome): string {
  return o.from && o.to ? ` (${o.from} → ${o.to})` : "";
}

export function outcomeView(o: UpdateOutcome): OutcomeView {
  const reason = reasonInWords(o.reason);
  switch (o.status) {
    case "succeeded":
      return {
        token: "applied",
        kind: "healthy",
        label: "Applied",
        sentence: o.to ? `Updated to ${o.to}.` : "The update was applied.",
        reason: null,
        didNotLand: false,
      };
    case "noop":
      // The engine was asked for the release the pod already runs.
      return {
        token: "up_to_date",
        kind: "healthy",
        label: "Up to date",
        sentence: o.to
          ? `Already on ${o.to}; nothing needed to change.`
          : "Already on the requested release; nothing needed to change.",
        reason: null,
        didNotLand: false,
      };
    case "rolled_back":
      return {
        token: "rolled_back",
        kind: "stale",
        label: "Rolled back",
        sentence:
          `The update${route(o)} didn't work, so the pod went back to ` +
          `${o.from ?? "its previous release"}` +
          (o.dbRestored
            ? " and its database was restored from the pre-update copy."
            : "."),
        reason,
        didNotLand: true,
      };
    case "rollback_failed":
      return {
        token: "rollback_failed",
        kind: "down",
        label: "Needs attention",
        sentence:
          "The update failed and the pod could not go back automatically. Check the machine hosting the pod.",
        reason,
        didNotLand: true,
      };
    case "failed":
      return {
        token: "failed",
        kind: "down",
        label: "Failed",
        sentence: `The update${route(o)} failed.`,
        reason,
        didNotLand: true,
      };
    case "aborted":
      return {
        token: "aborted",
        kind: "stale",
        label: "Didn't start",
        sentence:
          "The update stopped before changing anything. The pod is still on its previous release.",
        reason,
        // Nothing changed and nothing is broken: a note here, not a task for Home.
        didNotLand: false,
      };
    default:
      return {
        token: "other",
        kind: "unknown",
        label: o.status,
        sentence:
          "The pod recorded an update outcome this console doesn't recognise.",
        reason,
        didNotLand: false,
      };
  }
}

/**
 * The release the pod runs, as far as the last record proves it. An applied
 * update is on `to`; a rolled-back or aborted one is still on `from`. A failed
 * rollback leaves the pod's state unknown — never guessed.
 */
export function currentRelease(last: LastUpdate): string | null {
  if (last.kind !== "recorded") return null;
  const { status, from, to } = last.outcome;
  if (status === "succeeded" || status === "noop") return to;
  if (status === "rolled_back" || status === "aborted") return from;
  return null;
}

// ─── Home's Needs-you row ────────────────────────────────────────────────────

export interface UpdateIssue {
  /** `down` = the pod may be broken; `stale` = it is safe on its old release. */
  kind: Extract<StatusKind, "down" | "stale">;
  headline: string;
  secondary?: string;
}

/** The row Home shows when the last update did not land; null otherwise. */
export function updateIssue(last: LastUpdate): UpdateIssue | null {
  if (last.kind !== "recorded") return null;
  const view = outcomeView(last.outcome);
  if (!view.didNotLand) return null;
  const headline =
    view.token === "rolled_back"
      ? "The last update was rolled back"
      : view.token === "rollback_failed"
        ? "The last update failed and could not roll back"
        : "The last update failed";
  return {
    kind: view.kind === "down" ? "down" : "stale",
    headline,
    secondary: view.reason ?? undefined,
  };
}

// ─── Doing it now ────────────────────────────────────────────────────────────

/** The host command that updates now. The console cannot run host commands. */
export function updateCommand(channel: UpdateChannel): string {
  return `synap update --release ${channel}`;
}
