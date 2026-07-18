/**
 * Project Creation Guardrails (P1) — the ONE place project dedup, provenance,
 * and evidence-gravity logic lives.
 *
 * Context: AI agents minted projects per git-repo / per-feature / per-task, so
 * 18 projects existed where 2 were real. A project is a COMMITMENT WITH GRAVITY
 * (tasks/plans/repos are entities, never projects). These pure helpers back the
 * three creation doors (tRPC / hub-rest / mcp) and the ProjectRepository insert:
 *
 *   - normalized-name dedup: exact-normalized match ⇒ idempotent reuse; near
 *     match (token-set Jaccard ≥ NEAR_MATCH_THRESHOLD) ⇒ surface candidates.
 *   - provenance: every create stamps who/where it came from into metadata.
 *   - evidence gravity: an agent-initiated project needs ≥ MIN_EVIDENCE_ENTITIES
 *     existing, caller-visible entities as evidence, or it is rejected.
 *
 * DB-touching helpers (loadActiveProjectsForUser / findProjectDedupCandidates)
 * take an injected db so the pure functions above stay unit-testable without a
 * connection. Entity-visibility validation (which needs the API access layer)
 * lives in the router, NOT here.
 */

import { and, eq } from "drizzle-orm";
import { projects } from "../schema/projects.js";
import type { getDb } from "../client-pg.js";

// ── Provenance ────────────────────────────────────────────────────────────────

/** Recorded into `projects.metadata.provenance` on every create. */
export interface ProjectProvenance {
  createdByKind: "human" | "agent";
  door: "trpc" | "hub-rest" | "mcp";
  agentUserId?: string;
  /** Existing entity ids an agent supplied as the project's gravity evidence. */
  evidenceEntityIds?: string[];
  createdAtIso: string;
}

/** Build a provenance stamp from a door's immediate calling context. */
export function buildProjectProvenance(args: {
  door: ProjectProvenance["door"];
  agentUserId?: string | null;
  evidenceEntityIds?: string[];
}): ProjectProvenance {
  return {
    createdByKind: args.agentUserId ? "agent" : "human",
    door: args.door,
    ...(args.agentUserId ? { agentUserId: args.agentUserId } : {}),
    ...(args.evidenceEntityIds && args.evidenceEntityIds.length > 0
      ? { evidenceEntityIds: args.evidenceEntityIds }
      : {}),
    createdAtIso: new Date().toISOString(),
  };
}

// ── Name normalization + matching (pure) ──────────────────────────────────────

/** Common noise tokens dropped before comparing project names. */
const PROJECT_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "to",
  "project",
  "initiative",
  "workspace",
]);

/**
 * Normalize a project name for comparison: lowercase, strip punctuation, drop
 * stopwords, collapse whitespace. Two names with the same normalized form are
 * treated as the same project.
 */
export function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !PROJECT_STOPWORDS.has(t))
    .join(" ")
    .trim();
}

/** Normalized token set for a name (post stopword/punctuation strip). */
export function projectNameTokens(name: string): Set<string> {
  const normalized = normalizeProjectName(name);
  return new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
}

/**
 * Token-set overlap (Jaccard) of two names ∈ [0, 1]. Implemented in TS — no
 * pg_trgm / migration. 1.0 = same token set (order-insensitive).
 */
export function tokenSetOverlap(a: string, b: string): number {
  const ta = projectNameTokens(a);
  const tb = projectNameTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Token-set Jaccard at/above this ⇒ a near-duplicate candidate. */
export const NEAR_MATCH_THRESHOLD = 0.8;

export interface ExistingProjectRef {
  id: string;
  name: string;
  status?: string | null;
}

export interface ProjectDedupCandidate {
  id: string;
  name: string;
  /** Token-set overlap score with the requested name. */
  score: number;
}

export interface ProjectMatchResult {
  /** First existing project whose normalized name equals the requested one. */
  exact: ExistingProjectRef | null;
  /** Non-exact projects with overlap ≥ NEAR_MATCH_THRESHOLD, best first. */
  near: ProjectDedupCandidate[];
}

/**
 * Classify a requested project name against the caller's existing projects.
 * Pure — the caller supplies the candidate list.
 */
export function classifyProjectMatch(
  name: string,
  existing: ExistingProjectRef[]
): ProjectMatchResult {
  const target = normalizeProjectName(name);
  let exact: ExistingProjectRef | null = null;
  const near: ProjectDedupCandidate[] = [];

  for (const p of existing) {
    const normalized = normalizeProjectName(p.name);
    if (target.length > 0 && normalized === target) {
      if (!exact) exact = p; // stable: first exact wins
      continue;
    }
    const score = tokenSetOverlap(name, p.name);
    if (score >= NEAR_MATCH_THRESHOLD) {
      near.push({ id: p.id, name: p.name, score });
    }
  }

  near.sort((a, b) => b.score - a.score);
  return { exact, near };
}

// ── Evidence gravity (pure) ───────────────────────────────────────────────────

/** Minimum caller-visible entities an agent must link as project evidence. */
export const MIN_EVIDENCE_ENTITIES = 5;

export interface EvidenceGravityResult {
  ok: boolean;
  /** Instructive rejection message when !ok. */
  message?: string;
}

/**
 * Decide whether an agent-initiated project has enough gravity. `visibleCount`
 * is the number of the supplied evidence ids that actually exist and are visible
 * to the caller (validated in the router via the access layer — never trusted
 * from the request).
 */
export function assessEvidenceGravity(args: {
  providedCount: number;
  visibleCount: number;
  near: ProjectDedupCandidate[];
  minimum?: number;
}): EvidenceGravityResult {
  const minimum = args.minimum ?? MIN_EVIDENCE_ENTITIES;
  if (args.visibleCount >= minimum) return { ok: true };

  const candidateHint =
    args.near.length > 0
      ? ` Or use an existing project: ${args.near
          .slice(0, 3)
          .map((c) => `${c.name} (${c.id})`)
          .join(", ")}.`
      : "";

  return {
    ok: false,
    message:
      `A project is a commitment with gravity. Link ≥${minimum} existing entities ` +
      `as evidence (you provided ${args.providedCount}, of which ${args.visibleCount} ` +
      `exist and are visible to you), or store this as an entity (task/plan/note) instead.` +
      candidateHint,
  };
}

/** Message telling an agent to reuse a near-duplicate rather than create anew. */
export function buildNearMatchMessage(near: ProjectDedupCandidate[]): string {
  const list = near
    .slice(0, 3)
    .map((c) => `${c.name} (${c.id})`)
    .join(", ");
  return (
    `A very similar project already exists: ${list}. Reuse it (file entities into ` +
    `that project) instead of creating a near-duplicate. If this initiative is ` +
    `genuinely distinct, choose a clearly different name.`
  );
}

// ── DB-backed dedup lookup ────────────────────────────────────────────────────

type Db = Awaited<ReturnType<typeof getDb>>;

/** Load the user's ACTIVE projects (any workspace — projects are cross-cutting). */
export async function loadActiveProjectsForUser(
  db: Db,
  userId: string
): Promise<ExistingProjectRef[]> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
    })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.status, "active")));
}

/** Load the caller's active projects and classify a requested name against them. */
export async function findProjectDedupCandidates(
  db: Db,
  args: { userId: string; name: string }
): Promise<ProjectMatchResult> {
  const existing = await loadActiveProjectsForUser(db, args.userId);
  return classifyProjectMatch(args.name, existing);
}
