/**
 * Calibration: what agents did that an approval should change. The pure rules
 * behind Approvals › Calibration (moved from the desktop's Settings ›
 * Approvals › Calibration, decision b387ca45 D5). Four kinds of pattern, one
 * row shape:
 *
 *   ungoverned  ran with no request at all   `diagnose.ungovernedWrites`,
 *                                            grouped by agent × action
 *   rejected    keeps getting rejected       `proposals.groups({status:'rejected'})`,
 *                                            only clusters refused 2× or more,
 *                                            minus the ones marked expected
 *   repeats     asked more than once         `proposals.groups({status:'pending'})`,
 *                                            clusters with more than one copy
 *   auto        ran without asking           `proposals.list({status:'auto_approved'})`,
 *                                            grouped by agent × the pattern it matched
 *
 * Each row offers ONE way to act, without digging: "Make it ask first" writes
 * an approval row (this agent × this action → asks first), "Its approval"
 * opens the approval that let it run, "Mark expected" mutes a rejected
 * cluster, "Review together" opens the request queue.
 *
 * Risk ranks first: severity is read from the platform floor itself
 * (`@synap/governance-policy`: the admin actions and the destructive verbs),
 * never a second list. Then volume, then recency. No React; the row's
 * phrase comes from the vocabulary, in the viewer's locale.
 */

import { ADMIN_ACTIONS, isDestructiveAction } from "@synap/governance-policy";
import type { Locale } from "@synap-core/types/i18n";
import { proposalSubjectKind } from "../../app/proposal/[id]/proposal-subject-kind";
import {
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
  sentenceCaseLabel,
} from "@synap-core/types/vocabulary";

export type CalibrationKind = "ungoverned" | "rejected" | "repeats" | "auto";

/** Tab order: what ran with no request first, the audit last. */
export const CALIBRATION_KINDS: readonly CalibrationKind[] = [
  "ungoverned",
  "rejected",
  "repeats",
  "auto",
];

/**
 * Which non-empty tab opens first, by consequence: a write nothing governed
 * outranks a refused request, which outranks what an approval let through; a
 * duplicate is waste, not risk.
 */
export const CALIBRATION_ALARM_ORDER: readonly CalibrationKind[] = [
  "ungoverned",
  "rejected",
  "auto",
  "repeats",
];

/** A rejected cluster is a pattern from this many refusals up. */
export const REJECTED_MIN_COUNT = 2;

/** Rows shown per tab before "Show all" (ui-composition: lists are capped). */
export const CALIBRATION_CAP = 10;

/** Recent objects kept per row. */
const SAMPLES = 5;

/** Is the value a calibration kind (a `?kind=` param)? */
export function readCalibrationKind(
  v: string | null | undefined
): CalibrationKind | null {
  return (CALIBRATION_KINDS as readonly string[]).includes(v ?? "")
    ? (v as CalibrationKind)
    : null;
}

// ── Severity, from the platform floor ────────────────────────────────────────

export type Severity = "destructive" | "admin" | "ordinary";

const SEVERITY_RANK: Record<Severity, number> = {
  destructive: 2,
  admin: 1,
  ordinary: 0,
};

/** How risky one action is (`entity.delete`), by the floor's own lists. */
export function severityOf(action: string): Severity {
  if (ADMIN_ACTIONS.includes(action)) return "admin";
  if (isDestructiveAction(action)) return "destructive";
  return "ordinary";
}

/**
 * How risky an approval PATTERN is, by what it can cover: `*` and `prefix.*`
 * cover a delete (the destructive verbs are subject-agnostic), so a glob ranks
 * as destructive; an exact action ranks as itself; a class (`@reversible`)
 * covers only easily-undone writes.
 */
export function severityOfPattern(pattern: string): Severity {
  if (pattern === "*" || pattern.endsWith(".*")) return "destructive";
  if (pattern.startsWith("@")) return "ordinary";
  return severityOf(pattern);
}

// ── The raw reads (structural slices) ────────────────────────────────────────

export interface UngovernedWriteLike {
  id: string;
  agentUserId: string | null;
  agentType?: string | null;
  action: string;
  at: unknown;
  subjectType: string;
  subjectId: string;
}

export interface ClusterLike {
  fingerprint: string;
  proposalType: string;
  targetType: string;
  targetLabel: string;
  count: number;
  latestAt: unknown;
  sampleProposalIds: string[];
  sources: ReadonlyArray<{
    agentLabel?: string | null;
    agentUserId?: string | null;
  }>;
}

/** One `proposals.list` row of an auto-approved write, structurally. */
export interface AutoProposalLike {
  id: string;
  status: string;
  /** `entity` for an entity write: its own kind is the payload's profile. */
  targetType?: string | null;
  agentUserId?: string | null;
  agentActorName?: string | null;
  createdAt?: unknown;
  /** The approval row that let it run, when one did (the pod reads it once). */
  governanceRuleId?: string | null;
  data?: unknown;
  request?: { data?: unknown } | null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** A recent thing behind a pattern: a request, or the object it wrote. */
export type CalibrationSample =
  | { kind: "proposal"; id: string }
  | { kind: "object"; id: string; subjectType: string };

/** The one way to act a row offers. */
export type CalibrationDecision =
  | { kind: "ask-first"; agentUserId: string; targetPattern: string }
  | { kind: "approval"; ruleId: string }
  | { kind: "mark-expected"; fingerprint: string }
  | { kind: "review-together" };

export interface CalibrationPattern {
  key: string;
  kind: CalibrationKind;
  /** The agent to open, when exactly one is attributable. */
  agentUserId: string | null;
  /** Its name; `null` when unknown (never an id). */
  agentName: string | null;
  /** How many agents, when the pattern spans several. */
  agentCount: number;
  /** What happened, in the past mood ("Created notes"). */
  phrase: string;
  count: number;
  latestAt: number;
  severity: Severity;
  samples: CalibrationSample[];
  /** What the requests were about, when they name it. */
  targetLabel: string | null;
  decision: CalibrationDecision | null;
}

export interface CalibrationDeps {
  /** agentUserId → the roster's name. */
  agentNames: ReadonlyMap<string, string>;
  locale?: Locale;
}

/** Date over superjson, a string otherwise; 0 when unreadable. */
export function toMs(v: unknown): number {
  const t = new Date(v as string | number | Date).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** The governance action an event names: its phase suffix stripped. */
export function toGovernanceAction(eventType: string): string {
  return eventType.replace(/\.(completed|requested|failed)$/, "");
}

/** The agent's name: the roster's, else the read's label; never an id. */
export function agentNameOf(
  agentUserId: string | null | undefined,
  fallback: string | null | undefined,
  names: ReadonlyMap<string, string>
): string | null {
  const fromRoster = agentUserId ? names.get(agentUserId)?.trim() : undefined;
  if (fromRoster) return fromRoster;
  const label = fallback?.trim();
  return label && label !== agentUserId ? label : null;
}

/**
 * "Created notes": the past verb and the noun, from the vocabulary; the noun
 * is plural past one. `objectKind` null = read it from the action; "" = no
 * single kind (several kinds, or none known): the verb alone.
 */
export function pastPhrase(
  action: string,
  objectKind: string | null | undefined,
  count: number,
  locale?: Locale
): string {
  const verb = resolveActionLabel(action, "past", locale);
  const named =
    objectKind ??
    (action.includes(".") ? action.slice(0, action.lastIndexOf(".")) : "");
  // `entity` is the generic base kind: naming it adds nothing (the
  // vocabulary's own rule, `buildObjectActionTitle`), so the verb stands alone.
  const kind = named.toLowerCase() === "entity" ? "" : named;
  const noun = !kind
    ? ""
    : count === 1
      ? resolveObjectNoun(kind, locale)
      : locale
        ? resolveObjectNounPlural(kind, locale)
        : resolveObjectNounPlural(kind);
  return sentenceCaseLabel(noun ? `${verb} ${noun}` : verb);
}

export function ungovernedPatterns(
  writes: readonly UngovernedWriteLike[],
  deps: CalibrationDeps
): CalibrationPattern[] {
  const groups = new Map<
    string,
    {
      first: UngovernedWriteLike;
      action: string;
      count: number;
      latestAt: number;
      samples: CalibrationSample[];
    }
  >();
  for (const w of writes) {
    const action = toGovernanceAction(w.action);
    const key = `${w.agentUserId ?? "?"}::${action}`;
    const at = toMs(w.at);
    const sample: CalibrationSample = {
      kind: "object",
      id: w.subjectId,
      subjectType: w.subjectType,
    };
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.latestAt = Math.max(g.latestAt, at);
      if (
        g.samples.length < SAMPLES &&
        !g.samples.some((s) => s.id === w.subjectId)
      )
        g.samples.push(sample);
    } else {
      groups.set(key, {
        first: w,
        action,
        count: 1,
        latestAt: at,
        samples: [sample],
      });
    }
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    kind: "ungoverned" as const,
    agentUserId: g.first.agentUserId,
    agentName: agentNameOf(
      g.first.agentUserId,
      g.first.agentType,
      deps.agentNames
    ),
    agentCount: g.first.agentUserId ? 1 : 0,
    // The thing it wrote names the noun ("Created notes"), not the door.
    phrase: pastPhrase(g.action, g.first.subjectType, g.count, deps.locale),
    count: g.count,
    latestAt: g.latestAt,
    severity: severityOf(g.action),
    samples: g.samples,
    targetLabel: null,
    decision: g.first.agentUserId
      ? {
          kind: "ask-first" as const,
          agentUserId: g.first.agentUserId,
          targetPattern: g.action,
        }
      : null,
  }));
}

function clusterAgent(
  c: ClusterLike,
  names: ReadonlyMap<string, string>
): { id: string | null; name: string | null; count: number } {
  const ids = new Set(
    c.sources
      .map((s) => s.agentUserId ?? s.agentLabel)
      .filter((v): v is string => !!v)
  );
  if (ids.size !== 1) return { id: null, name: null, count: ids.size };
  const s = c.sources.find((x) => x.agentUserId || x.agentLabel)!;
  return {
    id: s.agentUserId ?? null,
    name: agentNameOf(s.agentUserId, s.agentLabel, names),
    count: 1,
  };
}

function clusterPattern(
  c: ClusterLike,
  kind: "rejected" | "repeats",
  decision: CalibrationDecision,
  deps: CalibrationDeps
): CalibrationPattern {
  const agent = clusterAgent(c, deps.agentNames);
  return {
    key: c.fingerprint,
    kind,
    agentUserId: agent.id,
    agentName: agent.name,
    agentCount: agent.count,
    phrase: pastPhrase(c.proposalType, c.targetType, c.count, deps.locale),
    count: c.count,
    latestAt: toMs(c.latestAt),
    severity: severityOf(c.proposalType),
    samples: c.sampleProposalIds
      .slice(0, SAMPLES)
      .map((id) => ({ kind: "proposal" as const, id })),
    targetLabel: c.targetLabel?.trim() || null,
    decision,
  };
}

/**
 * Refused twice or more, and not marked expected. An approval cannot stop an
 * agent from asking, so the way to act is to mark the refusals expected
 * (undone from the same page).
 */
export function rejectedPatterns(
  clusters: readonly ClusterLike[],
  muted: ReadonlySet<string>,
  deps: CalibrationDeps
): CalibrationPattern[] {
  return clusters
    .filter((c) => c.count >= REJECTED_MIN_COUNT && !muted.has(c.fingerprint))
    .map((c) =>
      clusterPattern(
        c,
        "rejected",
        { kind: "mark-expected", fingerprint: c.fingerprint },
        deps
      )
    );
}

/**
 * The same change waiting more than once. An approval decides the NEXT write,
 * so it cannot clear these: review the copies together.
 */
export function repeatPatterns(
  clusters: readonly ClusterLike[],
  deps: CalibrationDeps
): CalibrationPattern[] {
  return clusters
    .filter((c) => c.count > 1)
    .map((c) =>
      clusterPattern(c, "repeats", { kind: "review-together" }, deps)
    );
}

/** The pattern an auto-approved write matched (`data._autoApprove`). */
export function matchedPatternOf(p: AutoProposalLike): string | null {
  for (const source of [p.request?.data, p.data]) {
    if (!source || typeof source !== "object") continue;
    const marker = (source as { _autoApprove?: unknown })._autoApprove;
    if (!marker || typeof marker !== "object") continue;
    const pattern = (marker as { matchedPattern?: unknown }).matchedPattern;
    if (typeof pattern === "string" && pattern.trim()) return pattern.trim();
  }
  return null;
}

/**
 * Ran without asking, grouped by agent × the pattern (or approval) that let
 * it. An unattributed write cannot be grouped by agent: it is left out.
 * When an approval row let it run, the way to act is that approval (take it
 * back there); else, when a pattern let it, make this agent ask first.
 */
export function autoPatterns(
  proposals: readonly AutoProposalLike[],
  deps: CalibrationDeps
): CalibrationPattern[] {
  const groups = new Map<
    string,
    {
      first: AutoProposalLike;
      agentUserId: string;
      /** The kinds of the things it wrote (`proposalSubjectKind`). */
      kinds: Set<string>;
      pattern: string | null;
      ruleId: string | null;
      count: number;
      latestAt: number;
      samples: CalibrationSample[];
    }
  >();
  for (const p of proposals) {
    if (p.status !== "auto_approved" || !p.agentUserId) continue;
    const pattern = matchedPatternOf(p);
    const ruleId = p.governanceRuleId ?? null;
    const key = `${p.agentUserId}::${ruleId ?? pattern ?? "-"}`;
    const at = toMs(p.createdAt);
    const kind = p.targetType
      ? proposalSubjectKind(
          { targetType: p.targetType },
          p.request?.data ?? p.data
        )
      : null;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.latestAt = Math.max(g.latestAt, at);
      if (kind) g.kinds.add(kind);
      if (g.samples.length < SAMPLES)
        g.samples.push({ kind: "proposal", id: p.id });
    } else {
      groups.set(key, {
        first: p,
        agentUserId: p.agentUserId,
        kinds: new Set(kind ? [kind] : []),
        pattern,
        ruleId,
        count: 1,
        latestAt: at,
        samples: [{ kind: "proposal", id: p.id }],
      });
    }
  }
  return [...groups.entries()].map(([key, g]) => {
    // An exact action reads as what happened; a glob or a class has no
    // single verb, so the row says only that it ran without asking.
    const exact =
      g.pattern && !g.pattern.includes("*") && !g.pattern.startsWith("@");
    return {
      key,
      kind: "auto" as const,
      agentUserId: g.agentUserId,
      agentName: agentNameOf(
        g.agentUserId,
        g.first.agentActorName,
        deps.agentNames
      ),
      agentCount: 1,
      // The noun is the kind of the things it wrote, when they share one;
      // never the action's generic `entity`.
      phrase: exact
        ? pastPhrase(
            g.pattern!,
            g.kinds.size === 1 ? Array.from(g.kinds)[0]! : "",
            g.count,
            deps.locale
          )
        : "",
      count: g.count,
      latestAt: g.latestAt,
      severity: g.pattern ? severityOfPattern(g.pattern) : "ordinary",
      samples: g.samples,
      targetLabel: null,
      decision: g.ruleId
        ? { kind: "approval" as const, ruleId: g.ruleId }
        : g.pattern
          ? {
              kind: "ask-first" as const,
              agentUserId: g.agentUserId,
              targetPattern: g.pattern,
            }
          : null,
    };
  });
}

/** Risk first, then volume, then recency (a delete outranks forty creates). */
export function rankPatterns(
  rows: readonly CalibrationPattern[]
): CalibrationPattern[] {
  return [...rows].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.count - a.count ||
      b.latestAt - a.latestAt
  );
}

/**
 * The tab to open on: the most alarming kind that has patterns. `null` until
 * every read settled (a slow read never moves the person later) and when none
 * has any (the page says all is clear).
 */
export function defaultCalibrationKind(
  counts: Readonly<Record<CalibrationKind, number | null>>
): CalibrationKind | null {
  if (CALIBRATION_KINDS.some((k) => counts[k] === null)) return null;
  return CALIBRATION_ALARM_ORDER.find((k) => (counts[k] ?? 0) > 0) ?? null;
}

/**
 * The approval row "Make it ask first" writes: this agent × this action (or
 * pattern), across the pod → asks first. The most specific row wins, so it
 * holds over a broader "runs on its own".
 */
export function askFirstRuleInput(d: {
  agentUserId: string;
  targetPattern: string;
}) {
  return {
    principalKind: "agent" as const,
    agentUserId: d.agentUserId,
    scopeKind: "pod" as const,
    targetKind: "action" as const,
    targetPattern: d.targetPattern,
    verdict: "propose" as const,
  };
}
