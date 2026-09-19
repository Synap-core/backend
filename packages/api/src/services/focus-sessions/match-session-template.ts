/**
 * matchSessionTemplate — which playbook (if any) should shape a session an AI
 * is starting without naming one.
 *
 * Founder decision: a matched template is AUTO-APPLIED only above a confidence
 * threshold, and the start response always SAYS what was applied and how to
 * opt out. Silent template binding was the flagged wrong path, so this returns
 * a report even when nothing applied (`suggestions`), and the caller echoes it.
 *
 * Ranking is the EXISTING lexical ranker (`rankRouteCandidates`, the one
 * `playbooks.matchForEntity` and capture suggestions use) — this module only
 * builds the candidate list (active playbooks through the access layer; the
 * searchable text is name + description + goal template + stage names) and
 * keeps the candidates that the session's own words matched. The ranker's
 * rule is unchanged, so capture suggestions are unaffected.
 *
 *   0 matched  → nothing applied.
 *   1 matched  → applied when its lexical score ≥ {@link LEXICAL_AUTO_APPLY_SCORE}.
 *   ≥2 matched → the IS picks one or abstains (`/api/playbook-choice`); applied
 *                when its probability ≥ {@link AUTO_APPLY_PROBABILITY}. An IS
 *                that cannot answer applies nothing — suggestions only.
 *
 * The third-party decision model (JEV) is only allowed when the pod opted in
 * (`intelligenceDefaults.thirdPartyDecisionModel`, fail-closed reader).
 */
import { db, playbooks, eq, and, desc } from "@synap/database";
import { requestPlaybookChoice } from "@synap/intelligence-client";
import { createLogger } from "@synap-core/core";
import { scopedDb } from "../../access/scoped-db.js";
import { AccessContext } from "../../access/context.js";
import { rankRouteCandidates, tokenize } from "../routing/suggest-routes.js";
import { readPodThirdPartyDecisionModelConsent } from "../intake/pod-vision-preference.js";
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";

const logger = createLogger({
  module: "focus-sessions/match-session-template",
});

/** IS/JEV probability at or above which the pick is applied. */
export const AUTO_APPLY_PROBABILITY = 0.75;

/**
 * Lexical floor for the single-candidate case: two distinct words of the
 * session's title/goal found in the playbook (3 points each in the ranker).
 * One shared word ("review") is a coincidence, not a match.
 */
export const LEXICAL_AUTO_APPLY_SCORE = 6;

/** Candidates sent to the IS, best lexical first. */
const IS_CANDIDATES_MAX = 8;
const SUGGESTIONS_MAX = 5;

export const TEMPLATE_OPT_OUT = "pass templateId: null" as const;

export interface TemplateSuggestion {
  id: string;
  name: string;
  /** Lexical score from the shared ranker. */
  score: number;
  /** Why it matched, in words ("You mentioned “report”"). */
  reason: string;
}

/** The `template` block every start response carries when matching ran. */
export interface SessionTemplateReport {
  applied: {
    id: string;
    name: string;
    /** Probability (IS/JEV) or share of the session's words matched (lexical). */
    confidence: number;
    decider: "jev" | "llm" | "lexical";
  } | null;
  suggestions: TemplateSuggestion[];
  optOut: typeof TEMPLATE_OPT_OUT;
}

export interface MatchSessionTemplateInput {
  userId: string;
  agentUserId?: string;
  workspaceId?: string | null;
  title?: string | null;
  goal: string;
}

/** Test seam: the IS call (real one resolves the default service). */
export type PlaybookChooser = (input: {
  content: string;
  candidates: Array<{ id: string; name: string; description?: string }>;
  allowDecisionModel: boolean;
}) => Promise<{
  playbookId: string | null;
  confidence: number;
  decider: "jev" | "llm";
}>;

const defaultChooser: PlaybookChooser = async (input) => {
  const { endpoint, apiKey } = await getDefaultActiveService();
  return requestPlaybookChoice(endpoint, apiKey, input);
};

function stageNames(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) => (s as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string");
}

export async function matchSessionTemplate(
  input: MatchSessionTemplateInput,
  chooser: PlaybookChooser = defaultChooser
): Promise<SessionTemplateReport> {
  const none: SessionTemplateReport = {
    applied: null,
    suggestions: [],
    optOut: TEMPLATE_OPT_OUT,
  };
  const intentText = [input.title, input.goal].filter(Boolean).join(" ");

  const visibility = scopedDb(
    AccessContext.agent({
      userId: input.userId,
      agentUserId: input.agentUserId,
    }).withLens(input.workspaceId ?? undefined)
  ).predicate(playbooks);
  const rows = await db
    .select()
    .from(playbooks)
    .where(and(visibility, eq(playbooks.status, "active")))
    .orderBy(desc(playbooks.updatedAt));

  // No entity at session start: only the session's own WORDS are evidence.
  // (The kind / any-kind signals rank capture suggestions for an entity; here
  // they would match every playbook and prove nothing.)
  const matched = rankRouteCandidates({
    entity: {},
    intentText,
    candidates: rows.map((p) => ({
      kind: "playbook" as const,
      id: p.id,
      name: p.name,
      text: [p.description, p.goalTemplate, ...stageNames(p.stages)],
      subjectProfileSlug: null,
      description: p.description ?? undefined,
    })),
  }).filter((r) => r.signals.some((s) => s.type === "intent"));
  if (matched.length === 0) return none;

  const toSuggestion = (r: (typeof matched)[number]): TemplateSuggestion => ({
    id: r.candidate.id,
    name: r.candidate.name,
    score: r.score,
    reason: r.reason,
  });
  const suggestFrom = (appliedId: string | null) =>
    matched
      .filter((r) => r.candidate.id !== appliedId)
      .slice(0, SUGGESTIONS_MAX)
      .map(toSuggestion);

  if (matched.length === 1) {
    const only = matched[0];
    const intentTerms = only.signals.find((s) => s.type === "intent");
    const goalWords = tokenize(intentText).size;
    if (only.score >= LEXICAL_AUTO_APPLY_SCORE) {
      return {
        applied: {
          id: only.candidate.id,
          name: only.candidate.name,
          confidence:
            intentTerms?.type === "intent" && goalWords > 0
              ? Math.min(1, intentTerms.terms.length / goalWords)
              : 0,
          decider: "lexical",
        },
        suggestions: [],
        optOut: TEMPLATE_OPT_OUT,
      };
    }
    return { ...none, suggestions: suggestFrom(null) };
  }

  const pool = matched.slice(0, IS_CANDIDATES_MAX);
  try {
    const consent = await readPodThirdPartyDecisionModelConsent(db);
    const choice = await chooser({
      content: intentText.slice(0, 4000),
      candidates: pool.map((r) => ({
        id: r.candidate.id,
        name: r.candidate.name,
        ...(r.candidate.description
          ? { description: r.candidate.description }
          : {}),
      })),
      allowDecisionModel: consent.allowed,
    });
    const picked = choice.playbookId
      ? pool.find((r) => r.candidate.id === choice.playbookId)
      : undefined;
    if (picked && choice.confidence >= AUTO_APPLY_PROBABILITY) {
      return {
        applied: {
          id: picked.candidate.id,
          name: picked.candidate.name,
          confidence: choice.confidence,
          decider: choice.decider,
        },
        suggestions: suggestFrom(picked.candidate.id),
        optOut: TEMPLATE_OPT_OUT,
      };
    }
  } catch (err) {
    // The IS could not answer: nothing is applied on a guess. The lexical
    // candidates still ride back as suggestions.
    logger.warn({ err }, "playbook choice unavailable — suggestions only");
  }
  return { ...none, suggestions: suggestFrom(null) };
}
