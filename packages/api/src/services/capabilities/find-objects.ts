/**
 * The OBJECT catalogs of `findByIntent` — the things a person or an agent can
 * OPEN, found by their words: instruction skills and rules, automations,
 * sessions, goals, projects, saved views and documents.
 *
 * `find-intent.ts` answered "what can DO this" (runnable verbs, the intent
 * axis, playbooks, spaces). Every other object that says HOW something is done
 * — the synap-ui skill, a rule, an automation already wired, the session where
 * it was done last time — had no text door at all: `synap_ask` searches
 * entities and runbooks, and `searchInstructionSkills` was reachable only from
 * the Hub REST catalog. "How do I build a custom UI for my pipeline?" got stale
 * notes while the skill that answers it sat one query away (finding cb91b095).
 *
 * ── WHAT EACH CATALOG IS ────────────────────────────────────────────────────
 * One read per catalog, all in parallel, each:
 *   - floored by the SAME predicate the id prober (`resolveObjectKind`) and the
 *     registered VisibilityRule use for that table, so find never names a row
 *     `/open/<id>` would refuse to open;
 *   - matched by the ONE term matcher (`sqlTermMatch` for the "any term hits"
 *     filter and the candidate order, `rankByTerms` for the score);
 *   - bounded: at most {@link CANDIDATE_CAP} candidates are read, best lexical
 *     points first, then ranked with rarity over those candidates;
 *   - reported as `{ matches }` (searched; possibly empty) or `{ error }` (the
 *     read threw) — never a failed read rewritten as `matches: []`.
 *
 * Skills and rules reuse `searchInstructionSkills` unchanged (its own SQL
 * rarity over the whole gated set, the space's linked skills first).
 *
 * ── THE LENS ────────────────────────────────────────────────────────────────
 * Like `spaces`, these catalogs search everything the viewer can read: the
 * `workspaceId` lens is not a filter here (a session or a document filed in
 * another space is still the answer to "where did I do this"). The skills
 * catalog passes the lens to `searchInstructionSkills`, whose visibility tiers
 * and linked-first order depend on it; at pod altitude it reads every skill
 * the viewer can see in any of their spaces.
 */
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  isNull,
  ne,
  automations,
  documents,
  focusSessions,
  projects,
  projectTracks,
  views,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  queryTerms,
  rankByTerms,
  sqlTermMatch,
  type SqlMatchableText,
  type TermMatch,
} from "../../utils/term-match.js";
import {
  ownerPrivateVisibleWhere,
  userVisibleWhere,
} from "../../utils/user-visible-where.js";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { projectVisibleWhere } from "../../access/project-visibility.js";
import { AccessContext } from "../../access/context.js";
import { openLink } from "../../utils/deep-links.js";

/** The object catalogs, in the order they are reported. */
export const OBJECT_CATALOGS = [
  "skills",
  "automations",
  "sessions",
  "goals",
  "projects",
  "views",
  "documents",
] as const;
export type ObjectCatalog = (typeof OBJECT_CATALOGS)[number];

/** What a found row IS. `skill` and `rule` share the skills catalog. */
export type FoundObjectKind =
  | "skill"
  | "rule"
  | "automation"
  | "session"
  | "goal"
  | "project"
  | "view"
  | "document";

/** One object the query's words landed on, with how to open it. */
export interface FoundObject {
  kind: FoundObjectKind;
  id: string;
  title: string;
  /** One line: what it is or what it is for. `null` when the row says nothing. */
  why: string | null;
  /** `/open/<id>` — the app resolves the kind from the id. */
  open: string;
  /** Skills and rules: the slug `synap_load_skill({ ref })` reads. */
  ref?: string;
  workspaceId: string | null;
  score: number;
  /** `score` ÷ the best score in THIS catalog's block. */
  confidence: number;
  match: TermMatch;
  /** How many of the query's search terms this row hit. ABSOLUTE. */
  termCoverage: { hit: number; of: number };
}

/** `matches` and `error` are mutually exclusive: a failed read is `error`. */
export type FindObjects = { matches: FoundObject[] } | { error: string };

/** How many candidates one catalog reads before ranking. */
export const CANDIDATE_CAP = 25;

/** A `why` longer than this is cut: it is a line, not a body. */
const WHY_MAX = 160;

interface Candidate {
  kind: FoundObjectKind;
  id: string;
  title: string;
  why: string | null;
  /** Extra words the row answers to (labels, slug, status). */
  labels: string[];
  workspaceId: string | null;
  ref?: string;
}

function oneLine(text: string | null | undefined): string | null {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > WHY_MAX ? `${line.slice(0, WHY_MAX - 1)}…` : line;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message.length > 0
    ? err.message
    : String(err);
}

/**
 * The "any term hits" filter and an order by lexical points (every term
 * weighted 1 — rarity is measured afterwards, over what was read).
 */
function lexical(terms: string[], fields: SqlMatchableText) {
  const m = sqlTermMatch(terms, fields);
  return { where: m.anyHit, order: m.score(terms.map(() => 1)) };
}

type Reader = (terms: string[], userId: string) => Promise<Candidate[]>;

const readAutomations: Reader = async (terms, userId) => {
  const m = lexical(terms, {
    primary: [drizzleSql`${automations.name}`],
    tertiary: drizzleSql`${automations.description}`,
  });
  const rows = await db
    .select({
      id: automations.id,
      name: automations.name,
      description: automations.description,
      triggerType: automations.triggerType,
      status: automations.status,
      workspaceId: automations.workspaceId,
    })
    .from(automations)
    // The registered `automations` VisibilityRule — the `automation` probe's floor.
    .where(
      and(
        userVisibleWhere(automations.workspaceId, userId),
        ne(automations.status, "archived"),
        m.where
      )
    )
    .orderBy(desc(m.order), desc(automations.updatedAt))
    .limit(CANDIDATE_CAP);
  return rows.map((r) => ({
    kind: "automation",
    id: r.id,
    title: r.name,
    why:
      oneLine(r.description) ??
      `${r.triggerType ?? "manual"} automation, ${r.status ?? "draft"}`,
    labels: [],
    workspaceId: r.workspaceId ?? null,
  }));
};

const readSessions: Reader = async (terms, userId) => {
  const m = lexical(terms, {
    primary: [drizzleSql`${focusSessions.title}`],
    tertiary: drizzleSql`${focusSessions.goal}`,
  });
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      workspaceId: focusSessions.workspaceId,
    })
    .from(focusSessions)
    // THE session read rule (the `session` probe's floor): owner-only.
    .where(and(sessionReadableWhere({ userId }), m.where))
    .orderBy(desc(m.order), desc(focusSessions.updatedAt))
    .limit(CANDIDATE_CAP);
  return rows.map((r) => {
    const title = resolveSessionTitle(r) || "Session";
    // The goal says what the work was for; the title already names it.
    const goal = r.title ? oneLine(r.goal) : null;
    return {
      kind: "session",
      id: r.id,
      title,
      why: [r.status ? `Session, ${r.status}` : "Session", goal]
        .filter(Boolean)
        .join(": "),
      labels: [],
      workspaceId: r.workspaceId ?? null,
    };
  });
};

const readGoals: Reader = async (terms, userId) => {
  const m = lexical(terms, {
    primary: [drizzleSql`${projectTracks.name}`],
    tertiary: drizzleSql`${projects.name}`,
  });
  const rows = await db
    .select({
      id: projectTracks.id,
      name: projectTracks.name,
      status: projectTracks.status,
      projectName: projects.name,
      workspaceId: projects.workspaceId,
    })
    .from(projectTracks)
    .innerJoin(projects, eq(projects.id, projectTracks.projectId))
    // A goal is exactly as visible as its project (the `track` probe's floor).
    .where(
      and(projectVisibleWhere(AccessContext.operator({ userId })), m.where)
    )
    .orderBy(desc(m.order), desc(projectTracks.updatedAt))
    .limit(CANDIDATE_CAP);
  return rows.map((r) => ({
    kind: "goal",
    id: r.id,
    title: r.name,
    why: `Goal in project "${r.projectName}", ${r.status ?? "active"}`,
    labels: [],
    workspaceId: r.workspaceId ?? null,
  }));
};

const readProjects: Reader = async (terms, userId) => {
  const m = lexical(terms, {
    primary: [drizzleSql`${projects.name}`],
    tertiary: drizzleSql`${projects.description}`,
  });
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      workspaceId: projects.workspaceId,
    })
    .from(projects)
    // THE project predicate (the `project` probe's floor).
    .where(
      and(projectVisibleWhere(AccessContext.operator({ userId })), m.where)
    )
    .orderBy(desc(m.order), desc(projects.updatedAt))
    .limit(CANDIDATE_CAP);
  return rows.map((r) => ({
    kind: "project",
    id: r.id,
    title: r.name,
    why: oneLine(r.description) ?? `Project, ${r.status ?? "active"}`,
    labels: [],
    workspaceId: r.workspaceId ?? null,
  }));
};

const readViews: Reader = async (terms, userId) => {
  const m = lexical(terms, {
    primary: [drizzleSql`${views.name}`],
    secondary: drizzleSql`ARRAY[${views.type}]::text[]`,
    tertiary: drizzleSql`${views.description}`,
  });
  const rows = await db
    .select({
      id: views.id,
      name: views.name,
      description: views.description,
      type: views.type,
      workspaceId: views.workspaceId,
    })
    .from(views)
    // The canonical views floor (the `view` probe's): owner or member.
    .where(
      and(
        ownerPrivateVisibleWhere(views.workspaceId, views.userId, userId),
        m.where
      )
    )
    .orderBy(desc(m.order), desc(views.updatedAt))
    .limit(CANDIDATE_CAP);
  return rows.map((r) => ({
    kind: "view",
    id: r.id,
    title: r.name,
    why: oneLine(r.description) ?? `${r.type ?? "Saved"} view`,
    labels: r.type ? [r.type] : [],
    workspaceId: r.workspaceId ?? null,
  }));
};

const readDocuments: Reader = async (terms, userId) => {
  const m = lexical(terms, { primary: [drizzleSql`${documents.title}`] });
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      type: documents.type,
      workspaceId: documents.workspaceId,
    })
    .from(documents)
    .where(
      and(
        isNull(documents.deletedAt),
        // The registered `documents` VisibilityRule (the `document` probe's).
        accessScopeWhere({
          workspaceIdColumn: documents.workspaceId,
          entityIdColumn: documents.id,
          ownerColumn: documents.userId,
          userId,
          documentFollowsEntity: true,
        }),
        m.where
      )
    )
    .orderBy(desc(m.order), desc(documents.updatedAt))
    .limit(CANDIDATE_CAP);
  return rows.map((r) => ({
    kind: "document",
    id: r.id,
    title: r.title ?? "Untitled document",
    why: `${r.type ?? "markdown"} document`,
    labels: [],
    workspaceId: r.workspaceId ?? null,
  }));
};

/** Instruction skills and rules: the skills door, unchanged. */
function readSkills(query: string, workspaceId: string | null): Reader {
  return async (_terms, userId) => {
    const { searchInstructionSkills } = await import("../skills/search.js");
    const { rows } = await searchInstructionSkills({
      userId,
      ...(workspaceId ? { workspaceId } : { anyWorkspace: true }),
      // The raw query: the skills door reduces it with the same `queryTerms`.
      q: query,
      limit: CANDIDATE_CAP,
    });
    return rows.map((r) => ({
      // A rule is materialised as an instruction skill tagged `rule`
      // (services/rules/create.ts).
      kind: (r.tags ?? []).includes("rule") ? "rule" : "skill",
      id: r.id,
      title: r.name,
      why: oneLine(r.description),
      labels: [r.slug ?? "", ...(r.topics ?? []), ...(r.tags ?? [])].filter(
        Boolean
      ),
      workspaceId: r.workspaceId ?? null,
      ...(r.slug ? { ref: r.slug } : {}),
    }));
  };
}

function readerFor(
  catalog: ObjectCatalog,
  query: string,
  workspaceId: string | null
): Reader {
  switch (catalog) {
    case "skills":
      return readSkills(query, workspaceId);
    case "automations":
      return readAutomations;
    case "sessions":
      return readSessions;
    case "goals":
      return readGoals;
    case "projects":
      return readProjects;
    case "views":
      return readViews;
    case "documents":
      return readDocuments;
  }
}

/** Rank one catalog's candidates (rarity over THIS pool only) and shape the rows. */
function rank(
  query: string,
  candidates: Candidate[],
  terms: string[],
  limit: number
): FoundObject[] {
  const ranked = rankByTerms(
    query,
    candidates,
    (c) => ({ primary: c.title, secondary: c.labels, tertiary: c.why }),
    { primary: "title", secondary: "labels", tertiary: "why" }
  );
  const best = ranked[0]?.score ?? 0;
  return ranked.slice(0, limit).map(({ item, score, match }) => ({
    kind: item.kind,
    id: item.id,
    title: item.title,
    why: item.why,
    open: openLink(item.id),
    ...(item.ref ? { ref: item.ref } : {}),
    workspaceId: item.workspaceId,
    score,
    confidence: best > 0 ? Math.round((score / best) * 100) / 100 : 0,
    match,
    termCoverage: { hit: match.terms.length, of: terms.length },
  }));
}

export interface SearchObjectCatalogsInput {
  query: string;
  userId: string;
  workspaceId: string | null;
  catalogs: readonly ObjectCatalog[];
  limit: number;
}

/**
 * Search the named object catalogs IN PARALLEL. One catalog's failure is its
 * own `{ error }` and never fails the others.
 */
export async function searchObjectCatalogs(
  input: SearchObjectCatalogsInput
): Promise<Partial<Record<ObjectCatalog, FindObjects>>> {
  const terms = queryTerms(input.query);
  const entries = await Promise.all(
    input.catalogs.map(
      async (catalog): Promise<[ObjectCatalog, FindObjects]> => {
        if (terms.length === 0) return [catalog, { matches: [] }];
        try {
          const candidates = await readerFor(
            catalog,
            input.query,
            input.workspaceId
          )(terms, input.userId);
          return [
            catalog,
            { matches: rank(input.query, candidates, terms, input.limit) },
          ];
        } catch (err) {
          return [catalog, { error: errorText(err) }];
        }
      }
    )
  );
  return Object.fromEntries(entries) as Partial<
    Record<ObjectCatalog, FindObjects>
  >;
}
