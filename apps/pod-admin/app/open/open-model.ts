/**
 * The pure half of `/open`: what a failed load says, what a bounce card may
 * claim about the object it bounces, where a resolved bare id goes, and the
 * one-sentence summaries of the hosted operational kinds. The pages under
 * `/open` only fetch and draw.
 */

import {
  resolveObjectNounPlural,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { formatRelative, oneLine } from "../../lib/format";
import { BOUNCE_TYPES, HOST_TYPES } from "./open-params";

/**
 * The bounce card's sentence, DERIVED from `HOST_TYPES` so it cannot keep
 * saying "only entities and views" after a kind joins the web host (it did).
 */
export function bounceSummary(): string {
  const nouns = HOST_TYPES.map((t) => resolveObjectNounPlural(t).toLowerCase());
  const list =
    nouns.length > 1
      ? `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`
      : nouns.join("");
  return `The web shows ${list}. Open this one in the Synap app for the full surface.`;
}

/** `diagnose.resolveOpen`'s body (`OpenTarget`, resolve-open-target.ts). */
export interface ResolvedOpen {
  type: string;
  id: string;
  displayName: string | null;
  workspaceId: string | null;
  openable: boolean;
}

/**
 * What a bounce card may say about the object it bounces — or null on ANY
 * doubt, so the worst outcome of a miss is today's anonymous card.
 *
 * Only when the resolver agrees on the KIND: the typed link says
 * `document`, and an id the resolver reads as something else (or `unknown`)
 * gets no name — a confidently wrong name is worse than none. Never falls back
 * to the id: a uuid is not a name.
 */
export function bounceReceipt(
  linkType: string,
  resolved: ResolvedOpen | undefined
): { title: string; workspaceId: string | null } | null {
  if (!resolved || resolved.type !== linkType) return null;
  const title = resolved.displayName?.trim();
  if (!title) return null;
  return {
    title,
    // A space IS the scope — it has no space of its own to name.
    workspaceId: linkType === "workspace" ? null : resolved.workspaceId,
  };
}

const OPEN_TYPES: ReadonlySet<string> = new Set([
  ...HOST_TYPES,
  ...BOUNCE_TYPES,
]);

/**
 * Where a resolved bare id goes: pod-admin's own page for its kind (hosted,
 * or the named "opens in the app" card), or null when the resolver found
 * nothing the reader can see or nothing with a door.
 */
export function openPathForResolved(resolved: ResolvedOpen): string | null {
  if (!resolved.openable) return null;
  const id = encodeURIComponent(resolved.id);
  if (resolved.type === "proposal") return `/proposal/${id}`;
  if (!OPEN_TYPES.has(resolved.type)) return null;
  return `/open/${resolved.type}/${id}`;
}

const MAX_SUMMARY = 280;

/** One readable paragraph, or null. */
export function shortDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return oneLine(value, MAX_SUMMARY) || null;
}

/** The property an entity's summary line is read from, first match wins. */
const SUMMARY_PROPERTIES = ["description", "content"] as const;

/**
 * An entity's summary: its preview / description column, else its first
 * prose property — and WHICH property, so the field list does not show the
 * same words twice.
 */
export function entitySummary(entity: {
  preview?: string | null;
  description?: string | null;
  properties?: Record<string, unknown> | null;
}): { text: string | null; propertySlug: string | null } {
  const direct = shortDescription(entity.preview ?? entity.description);
  if (direct) return { text: direct, propertySlug: null };
  for (const slug of SUMMARY_PROPERTIES) {
    const text = shortDescription(entity.properties?.[slug]);
    if (text) return { text, propertySlug: slug };
  }
  return { text: null, propertySlug: null };
}

const REDACTED = "••••••";

/**
 * Properties with every SECRET-typed value masked, for the raw JSON panel.
 * The field list never draws a secret; the copyable raw record must not be
 * the way around that.
 */
export function redactSecretProperties(
  properties: Record<string, unknown>,
  defs: ReadonlyArray<{ slug: string; valueType: string }>
): Record<string, unknown> {
  const secret = new Set(
    defs.filter((d) => d.valueType === "secret").map((d) => d.slug)
  );
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      secret.has(key) && value != null ? REDACTED : value,
    ])
  );
}

/** The fields of an `automations` row the summary reads. */
export interface AutomationFacts {
  status: string;
  triggerType: string;
  errorMessage?: string | null;
  nextRunAt?: Date | string | null;
  runCount: number;
  failureCount: number;
}

/** One sentence on what a rule is doing right now. */
export function automationSummary(a: AutomationFacts): string {
  switch (a.status) {
    case "error":
      return a.errorMessage?.trim()
        ? `Stopped on an error: ${a.errorMessage.trim()}`
        : "Stopped on an error.";
    case "paused":
      return "Paused — it won’t run until it’s switched back on.";
    case "draft":
      return "A draft — it has never been switched on.";
    case "archived":
      return "Archived — it no longer runs.";
  }
  const when =
    a.triggerType === "cron"
      ? a.nextRunAt
        ? `Runs on a schedule; next run ${formatRelative(a.nextRunAt)}.`
        : "Runs on a schedule."
      : a.triggerType === "event"
        ? "Runs when its trigger event happens."
        : a.triggerType === "webhook"
          ? "Runs when its webhook is called."
          : "Runs when someone starts it.";
  if (a.runCount > 0 && a.failureCount > 0) {
    return `${when} ${a.failureCount} of ${a.runCount} runs failed.`;
  }
  return when;
}

/** The fields of an `automation_runs` row a run line reads. */
export interface RunFacts {
  status: string;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  errorMessage?: string | null;
  stepsCompleted?: number;
}

/** One run as a list line: when, and what went wrong (or how far it got). */
export function runLine(run: RunFacts): {
  primary: string;
  secondary: string;
} {
  const primary = `Started ${formatRelative(run.startedAt, { empty: "at an unknown time" })}`;
  const error = run.errorMessage?.trim();
  if (error) {
    return {
      primary,
      secondary: oneLine(error, 140),
    };
  }
  const steps = run.stepsCompleted ?? 0;
  const stepWord = `${steps} ${steps === 1 ? "step" : "steps"}`;
  return {
    primary,
    secondary: run.completedAt
      ? `${stepWord} · finished ${formatRelative(run.completedAt)}`
      : `${stepWord} so far`,
  };
}

/** Statuses a session can still be cancelled from (it has work in flight). */
const CANCELLABLE = new Set([
  "active",
  "paused",
  "forming",
  "scheduled",
  "stale",
]);

export function sessionCanCancel(status: string): boolean {
  return CANCELLABLE.has(status);
}

/** Closed sessions are where an undo makes sense — their work has landed. */
export function sessionCanRevert(status: string): boolean {
  return !CANCELLABLE.has(status);
}

export interface SessionFacts {
  status: string;
  closedAt?: Date | string | null;
  liveness?:
    | { status: "ok"; lastAgentActivityAt: Date | string | null }
    | { status: "unavailable"; reason: string }
    | null;
}

/** One sentence on where a session stands. */
export function sessionSummary(s: SessionFacts): string {
  if (!CANCELLABLE.has(s.status)) {
    const when = s.closedAt ? ` ${formatRelative(s.closedAt)}` : "";
    return `${resolveStatusLabel(s.status)}${when}.`;
  }
  if (s.status === "paused") return "Paused — no agent is working on it.";
  if (s.status === "scheduled") return "Scheduled — it hasn’t started yet.";
  // A FAILED liveness read says nothing about agents — never "none yet".
  if (s.liveness?.status !== "ok") return "In progress.";
  const last = s.liveness.lastAgentActivityAt;
  return last
    ? `In progress — an agent last acted ${formatRelative(last)}.`
    : "In progress — no agent has acted on it yet.";
}
