/**
 * Marketplace › Catalog — the pure shaping between the pod's `marketplace.*`
 * answers and what the console says. No React, so every sentence is tested.
 *
 * Words come from `@synap-core/types/vocabulary`: a catalog kind is named by
 * the registry kind the server pairs it with (`objectKind` — a `template` is
 * a `workspace`, so it reads "Space"). The three tool-family kinds share ONE
 * user word ("Tool"), so a filter that lists them side by side uses the
 * registry's own kind labels for that family (`TOOL_KIND_LABELS`: Action,
 * Skill) — the same door a detail page uses to name which kind of tool.
 */

import {
  OBJECT_KINDS,
  OBJECT_KIND_ALIASES,
  TOOL_KIND_LABELS,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { formatRelative } from "../../../../lib/format";
import type { CatalogSource, InstallOutcome } from "./types";

/** The chip/badge word for a catalog kind, from its registry kind. */
export function catalogKindLabel(objectKind: string): string {
  return TOOL_KIND_LABELS[objectKind] ?? resolveObjectNoun(objectKind);
}

/** "1 rule" / "3 rules" — both words from the registry, never `+ "s"`. */
export function countNoun(kind: string, count: number): string {
  const canonical = OBJECT_KIND_ALIASES[kind] ?? kind;
  const entry = OBJECT_KINDS[canonical];
  const word =
    count === 1
      ? (entry?.label ?? resolveObjectNoun(kind))
      : (entry?.labelPlural ?? resolveObjectNoun(kind));
  return `${count} ${word.toLowerCase()}`;
}

/**
 * The detail link for a catalog entry. `kind` and `source` ride the query:
 * a slug is unique only within (source, kind), and the pod refuses an
 * ambiguous install rather than picking one.
 */
export function catalogDetailHref(entry: {
  kind: string;
  slug: string;
  source: string;
}): string {
  const query = new URLSearchParams({ kind: entry.kind, source: entry.source });
  return `/marketplace/${encodeURIComponent(entry.slug)}?${query}`;
}

/**
 * One line on where the catalog comes from and how fresh it is — null when the
 * pod has no source at all (the empty state says that instead).
 */
export function catalogFreshness(sources: CatalogSource[]): string | null {
  const live = sources.filter((s) => s.configured);
  if (live.length === 0) return null;
  return live
    .map((s) => {
      if (!s.lastSyncAt) {
        return `${s.name} has not synced yet — the pod refreshes its catalog every 10 minutes.`;
      }
      const when = formatRelative(s.lastSyncAt);
      return s.unreachable
        ? `Couldn't reach ${s.name} at the last attempt (${when}) — showing the copy the pod already has.`
        : `From ${s.name} · refreshed ${when}.`;
    })
    .join(" ");
}

export type InstallTone = "healthy" | "stale";

export interface InstallSummary {
  tone: InstallTone;
  sentence: string;
  /** The space a template built or brought up to date. */
  workspaceId: string | null;
  /** Set when the install became a proposal someone must approve. */
  proposalId: string | null;
}

type Bag = Record<string, unknown>;

function list(value: unknown): Bag[] {
  return Array.isArray(value)
    ? value.filter((v): v is Bag => !!v && typeof v === "object")
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function done(sentence: string, tone: InstallTone = "healthy"): InstallSummary {
  return { tone, sentence, workspaceId: null, proposalId: null };
}

function describeTemplate(result: Bag): InstallSummary {
  const workspaceId =
    typeof result.workspaceId === "string" ? result.workspaceId : null;
  const failed = list(result.layers).find((l) => l.status === "failed");
  if (failed) {
    return {
      tone: "stale",
      sentence: `The space is there, but part of the package did not apply${
        typeof failed.message === "string" ? `: ${failed.message}` : "."
      } Install again to resume.`,
      workspaceId,
      proposalId: null,
    };
  }
  return {
    tone: "healthy",
    sentence:
      result.created === true
        ? "A new space was created from this package."
        : "Already installed — the pod brought the existing space in line with this package.",
    workspaceId,
    proposalId: null,
  };
}

function describeAutomation(result: Bag): InstallSummary {
  const items = list(result.automations);
  const created = items.filter((a) => a.status === "created").length;
  const reused = items.filter((a) => a.status === "reused").length;
  const errors = items.filter((a) => a.status === "error");
  const parts: string[] = [];
  if (created > 0) parts.push(`Added ${countNoun("automation", created)}.`);
  if (reused > 0) {
    parts.push(
      `${countNoun("automation", reused)} ${reused === 1 ? "was" : "were"} already there.`
    );
  }
  if (errors.length > 0) {
    parts.push(
      `${countNoun("automation", errors.length)} could not be added: ${errors
        .map((e) => `${String(e.name)} (${String(e.message)})`)
        .join("; ")}.`
    );
  }
  return done(
    parts.join(" ") || "Nothing to add.",
    errors.length > 0 ? "stale" : "healthy"
  );
}

function describeView(result: Bag): InstallSummary {
  const created = strings(result.created).length;
  const updated = strings(result.updated).length;
  const failed = list(result.failed);
  const parts: string[] = [];
  if (created > 0) parts.push(`Added ${countNoun("view", created)}.`);
  if (updated > 0) parts.push(`Updated ${countNoun("view", updated)}.`);
  if (failed.length > 0) {
    parts.push(
      `${countNoun("view", failed.length)} could not be added: ${failed
        .map((f) => `${String(f.name)} (${String(f.error)})`)
        .join("; ")}.`
    );
  }
  return done(parts.join(" "), failed.length > 0 ? "stale" : "healthy");
}

/**
 * What the pod says it did, as one sentence — read from the result's own
 * fields, never inferred from the absence of an error.
 */
export function describeInstall(outcome: InstallOutcome): InstallSummary {
  if (outcome.status === "proposed") {
    return {
      tone: "stale",
      sentence:
        "Sent for review. It installs once someone with access approves it.",
      workspaceId: null,
      proposalId: outcome.proposalId,
    };
  }
  const result = outcome.result as Bag;
  switch (result.kind) {
    case "template":
      return describeTemplate(result);
    case "automation":
      return describeAutomation(result);
    case "view":
      return describeView(result);
    case "capability":
      return done(
        result.created === false
          ? "Already installed — nothing new was added."
          : "Installed."
      );
    case "cell":
      return done(
        result.changeType === "updated"
          ? "Already installed — the pod updated it to this version."
          : "Installed."
      );
    default:
      return done("Installed.");
  }
}
