/**
 * matchSessionTemplate — which of the pod's playbooks fit the session an AI is
 * about to start. SUGGEST-ONLY: it applies NOTHING.
 *
 * Founder decision 2026-09-20 — discovery is a property of the DOOR, not a
 * plea in prose: "make sure AIs always fetch session playbooks before creating
 * a session". So the start door ALWAYS hands back the pod's existing processes,
 * ranked, with the reason each one matched, and the caller decides. Naming a
 * playbook with `templateId` is now the ONLY way one binds at start.
 *
 * WHAT WAS RETIRED, AND WHY. Until this date the door auto-applied a playbook
 * above a confidence threshold (a lexical floor for a lone candidate, an IS
 * `/api/playbook-choice` tiebreak above 0.75 for several). Measured on the live
 * pod: auto-apply had bound 0 of 6 work sessions. And no comparable product
 * binds a process on a confidence score — Devin, Linear and Jira all make the
 * choice named. So the thresholds, the IS chooser and the `applied` /
 * `notApplied` report are gone; a threshold that fires for nobody is a rule
 * that only ever surprises.
 *
 * Ranking is the EXISTING lexical ranker (`rankRouteCandidates`, the one
 * `playbooks.matchForEntity` and capture suggestions use) — this module only
 * builds the candidate list (active playbooks through the access layer; the
 * searchable text is name + description + goal template + stage names) and
 * keeps the candidates that the session's own words matched. The ranker's rule
 * is unchanged, so capture suggestions are unaffected.
 */
import { db, playbooks, eq, and, desc } from "@synap/database";
import { scopedDb } from "../../access/scoped-db.js";
import { AccessContext } from "../../access/context.js";
import { rankRouteCandidates } from "../routing/suggest-routes.js";

/** How many ranked candidates ride back on a start. */
const CANDIDATES_MAX = 5;

export const TEMPLATE_OPT_OUT = "pass templateId: null" as const;

export interface PlaybookCandidate {
  id: string;
  name: string;
  /** Lexical score from the shared ranker. */
  score: number;
  /** Why it matched, in words ("You mentioned “report”"). */
  reason: string;
}

/**
 * The `playbooks` block every start response carries when matching ran — the
 * pod handing over its existing processes. An EMPTY `candidates` is a fact
 * ("nothing of yours matched these words"), not a failure.
 *
 * There is deliberately no `applied` and no `notApplied`: nothing is applied,
 * so both fields could only ever say the same thing, and a field that cannot
 * vary is noise a reader must learn to ignore.
 */
export interface SessionPlaybookCandidates {
  candidates: PlaybookCandidate[];
  /** How to skip matching entirely on the next start. */
  optOut: typeof TEMPLATE_OPT_OUT;
}

export interface MatchSessionTemplateInput {
  userId: string;
  agentUserId?: string;
  workspaceId?: string | null;
  title?: string | null;
  goal: string;
}

function stageNames(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) => (s as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string");
}

export async function matchSessionTemplate(
  input: MatchSessionTemplateInput
): Promise<SessionPlaybookCandidates> {
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

  return {
    candidates: matched.slice(0, CANDIDATES_MAX).map((r) => ({
      id: r.candidate.id,
      name: r.candidate.name,
      score: r.score,
      reason: r.reason,
    })),
    optOut: TEMPLATE_OPT_OUT,
  };
}
