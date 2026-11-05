/**
 * resolveBindingRung — which playbook a session FOLLOWS, decided on FACTS.
 *
 * Founder decisions of 2026-11-05 (session 6307df89, plan document 7fbd45a7
 * "Plan 2026-11-05: session binding, playbook matcher and pod default replies"):
 *   d01 the server binds on facts only: an explicit id, the subject entity's
 *       kind, the parent session's playbook, a `main red:` title. A TEXT match
 *       (`matchSessionTemplate`) stays an offer and never binds;
 *   d02 it binds at start and once more when a subject or goal first arrives,
 *       through the existing follow door (`follow-playbook.ts`);
 *   d03 nothing matches ⇒ no binding: no default playbook.
 *
 * PURE: the caller loads the facts (`bind-on-facts.ts`) and applies the
 * decision. Only ACTIVE playbooks are considered, so a draft, paused or
 * archived playbook never binds: a playbook joins this ladder the moment a
 * person activates it, and not before.
 *
 * The rungs, first that decides wins:
 *   1 `explicit`  — the caller named a playbook (`templateId`). Always binds.
 *   2 `subject`   — the subject's kind against the playbooks declaring it
 *                   (`subjectProfile.profileSlug`), keeping only those whose
 *                   subject filter passes and, when the playbook maps stages
 *                   to the subject's status, whose stages cover the subject's
 *                   current status. Playbooks of the session's space are
 *                   tried before pod-wide ones; exactly ONE binds, several
 *                   are an offer.
 *   3 `parent`    — the parent session follows an active playbook: the child
 *                   (a lane of that work) follows it too.
 *   4 `main-red`  — the title starts with `main red:` (the grammar
 *                   `.claude/rules/github-ci.md` mandates, `main red: <repo>
 *                   <check> @<sha8>`): the active playbook named for main red.
 * When rung 2 found several candidates, rungs 3 and 4 may only pick among
 * them; otherwise the rung-2 offer stands.
 *
 * Never a bind (each falls through to the next rung):
 *   - a project-scope playbook (a goal template; it runs as a track);
 *   - a pinned playbook (`inputStrategy.kind: pinned`: its pin list is its door);
 *   - a playbook of another space than the session's;
 *   - a playbook that declares a subject kind the session does not have (rungs
 *     3 and 4: binding it would run a subject process with no subject).
 * Required params the facts do not answer are NOT invented: the follow door
 * files them as slots owed by the person, as for any follow.
 */
import {
  readSubjectLifecycle,
  stageForSubjectStatus,
  readPlaybookParams,
} from "@synap/playbooks";
import { evaluateSubjectFilter } from "../playbooks/subject-filter.js";
import { isPinnedStrategy } from "../playbooks/pinned-subject.js";

export type BindingRung = "explicit" | "subject" | "parent" | "main-red";

/** The slice of a `playbooks` row the ladder reads. */
export interface BindingPlaybook {
  id: string;
  name: string;
  status: string;
  scope: string | null;
  workspaceId: string | null;
  subjectProfile: unknown;
  inputStrategy?: unknown;
  stages: unknown;
  params?: unknown;
}

export interface BindingSituation {
  /** The playbook the caller named, if any. */
  explicitPlaybookId?: string | null;
  title?: string | null;
  /**
   * The space the session works in: the session's own, else its subject's.
   * Space-scoped playbooks of OTHER spaces never bind.
   */
  workspaceId: string | null;
  subject?: {
    /** The subject's kind (profile slug). */
    kind: string | null;
    properties: Record<string, unknown>;
  } | null;
  /** The parent session, when this one has one the caller owns. */
  parent?: {
    id: string;
    playbookId: string | null;
    currentStage: string | null;
  } | null;
}

export type BindingDecision =
  | {
      kind: "bind";
      rung: BindingRung;
      playbookId: string;
      playbookName: string;
      reason: string;
      /** Param answers read from the facts (rung 4: the title). */
      params?: Record<string, string>;
    }
  | {
      kind: "offer";
      rung: BindingRung;
      reason: string;
      candidates: Array<{ id: string; name: string }>;
    }
  | { kind: "none" };

/**
 * `main red: <repo> <check> @<sha8>` (`.claude/rules/github-ci.md`, "Never",
 * step 2). `<check>` may hold spaces ("Full suite", "API e2e").
 */
const MAIN_RED_PREFIX = /^\s*main red:/i;
const MAIN_RED_GRAMMAR =
  /^\s*main red:\s*(\S+)\s+(.+?)\s+@([0-9a-f]{7,40})\s*$/i;
/** How a playbook is named for main red ("Fix main red", "main-red"). */
const MAIN_RED_NAME = /\bmain[\s-]red\b/i;

export function parseMainRedTitle(
  title: string | null | undefined
): { repo: string; check: string; sha8: string } | "prefix-only" | null {
  if (!title || !MAIN_RED_PREFIX.test(title)) return null;
  const m = MAIN_RED_GRAMMAR.exec(title);
  if (!m) return "prefix-only";
  return { repo: m[1]!, check: m[2]!, sha8: m[3]!.slice(0, 8) };
}

const id8 = (id: string) => id.slice(0, 8);

function inSpace(p: BindingPlaybook, workspaceId: string | null): boolean {
  return p.workspaceId == null || p.workspaceId === workspaceId;
}

/** May the server bind this playbook at all (status, scope, space, pin)? */
function bindable(p: BindingPlaybook, workspaceId: string | null): boolean {
  return (
    p.status === "active" &&
    p.scope !== "project" &&
    !isPinnedStrategy(p.inputStrategy) &&
    inSpace(p, workspaceId)
  );
}

function declaredSubjectKind(p: BindingPlaybook): string | null {
  return readSubjectLifecycle(p.subjectProfile).profileSlug;
}

/** Rungs 3 and 4: a playbook that runs on a subject needs THAT subject. */
function subjectFits(
  p: BindingPlaybook,
  subject: BindingSituation["subject"]
): boolean {
  const kind = declaredSubjectKind(p);
  return kind == null || kind === (subject?.kind ?? null);
}

/** Rung 2: the subject passes the playbook's filter and status coverage. */
function coversSubject(
  p: BindingPlaybook,
  subject: NonNullable<BindingSituation["subject"]>
): boolean {
  if (declaredSubjectKind(p) !== subject.kind) return false;
  const filter = (p.subjectProfile as { filter?: unknown } | null)?.filter;
  if (evaluateSubjectFilter(filter, subject.properties) !== "pass") {
    return false;
  }
  const { statusProperty, humanOnlyStatuses } = readSubjectLifecycle(
    p.subjectProfile
  );
  const stages = Array.isArray(p.stages) ? (p.stages as unknown[]) : [];
  const mapsStatus = stages.some(
    (s) =>
      typeof (s as { subjectStatus?: unknown } | null)?.subjectStatus ===
      "string"
  );
  if (statusProperty && mapsStatus) {
    const value = subject.properties[statusProperty];
    if (typeof value === "string" && humanOnlyStatuses.includes(value)) {
      return false;
    }
    if (stageForSubjectStatus(stages, value) === null) return false;
  }
  return true;
}

export function resolveBindingRung(
  situation: BindingSituation,
  pool: readonly BindingPlaybook[]
): BindingDecision {
  // Rung 1 — named by the caller. The start door already loaded and floored
  // it; the ladder only records why it is followed.
  if (situation.explicitPlaybookId) {
    const named = pool.find((p) => p.id === situation.explicitPlaybookId);
    return {
      kind: "bind",
      rung: "explicit",
      playbookId: situation.explicitPlaybookId,
      playbookName: named?.name ?? situation.explicitPlaybookId,
      reason: "you named it",
    };
  }

  const ws = situation.workspaceId;
  const live = pool.filter((p) => bindable(p, ws));
  const subject = situation.subject ?? null;

  // Rung 2 — the subject's kind.
  let restrictTo: Set<string> | null = null;
  let subjectOffer: Extract<BindingDecision, { kind: "offer" }> | null = null;
  if (subject?.kind) {
    const fit = live.filter((p) => coversSubject(p, subject));
    const ownSpace = fit.filter((p) => ws != null && p.workspaceId === ws);
    const tier = ownSpace.length > 0 ? ownSpace : fit;
    if (tier.length === 1) {
      const p = tier[0]!;
      return {
        kind: "bind",
        rung: "subject",
        playbookId: p.id,
        playbookName: p.name,
        reason: `the subject's kind is ${subject.kind} and "${p.name}" is the one active playbook for it${p.workspaceId ? " in this space" : ""}`,
      };
    }
    if (tier.length > 1) {
      restrictTo = new Set(tier.map((p) => p.id));
      subjectOffer = {
        kind: "offer",
        rung: "subject",
        reason: `${tier.length} active playbooks run on kind ${subject.kind}; none was picked for you`,
        candidates: tier.map((p) => ({ id: p.id, name: p.name })),
      };
    }
  }
  const allowed = (p: BindingPlaybook) =>
    (restrictTo === null || restrictTo.has(p.id)) && subjectFits(p, subject);

  // Rung 3 — the parent's playbook.
  const parent = situation.parent;
  if (parent?.playbookId) {
    const p = live.find((x) => x.id === parent.playbookId);
    if (p && allowed(p)) {
      return {
        kind: "bind",
        rung: "parent",
        playbookId: p.id,
        playbookName: p.name,
        reason: `its parent session ${id8(parent.id)} follows "${p.name}"${parent.currentStage ? ` (stage ${parent.currentStage})` : ""}`,
      };
    }
  }

  // Rung 4 — the `main red:` title the github-ci rule mandates.
  const mainRed = parseMainRedTitle(situation.title);
  if (mainRed) {
    const named = live.filter((p) => MAIN_RED_NAME.test(p.name) && allowed(p));
    if (named.length === 1) {
      const p = named[0]!;
      const declared = new Set(
        readPlaybookParams(p.params).map((d) => d.name)
      );
      const params =
        mainRed === "prefix-only"
          ? undefined
          : Object.fromEntries(
              Object.entries(mainRed).filter(([k]) => declared.has(k))
            );
      return {
        kind: "bind",
        rung: "main-red",
        playbookId: p.id,
        playbookName: p.name,
        reason: `the title says "main red:" and "${p.name}" is the active main-red playbook`,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      };
    }
    if (named.length > 1 && !subjectOffer) {
      return {
        kind: "offer",
        rung: "main-red",
        reason: `${named.length} active playbooks are named for main red; none was picked for you`,
        candidates: named.map((p) => ({ id: p.id, name: p.name })),
      };
    }
  }

  return subjectOffer ?? { kind: "none" };
}

/** At most this many characters: the reply line stays one line. */
export const BINDING_LINE_MAX = 400;
/** Offered ids per line; the rest are one synap_match_playbooks away. */
const OFFER_IDS_MAX = 3;
const NAME_MAX = 48;

const clip = (s: string) =>
  s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s;

export type BindingLineOutcome =
  | {
      kind: "bound";
      playbookId: string;
      playbookName: string;
      reason: string;
    }
  | {
      kind: "offer";
      reason: string;
      candidates: Array<{ id: string; name: string }>;
    }
  | {
      /** A fact named it but the follow door did not attach it. */
      kind: "not_bound";
      playbookId: string;
      playbookName: string;
      reason: string;
    };

/**
 * The ONE line a reply carries about binding, never a block. Ids are never
 * clipped (a clipped id is a claim the pod did not make): when the line would
 * run past {@link BINDING_LINE_MAX}, the reason is dropped instead.
 */
export function bindingLine(outcome: BindingLineOutcome): string {
  const render = (withReason: boolean): string => {
    switch (outcome.kind) {
      case "bound":
        return `Follows "${clip(outcome.playbookName)}" (${outcome.playbookId})${withReason ? `: ${outcome.reason}` : ""}. Release: update_session followPlaybookId: null.`;
      case "offer":
        return `No playbook bound${withReason ? `: ${outcome.reason}` : ""}. To follow one: update_session followPlaybookId: ${outcome.candidates
          .slice(0, OFFER_IDS_MAX)
          .map((c) => `${c.id} (${clip(c.name)})`)
          .join(", ")}.`;
      case "not_bound":
        return `Not bound to "${clip(outcome.playbookName)}" (${outcome.playbookId})${withReason ? `: ${outcome.reason}` : ""}. To follow it: update_session followPlaybookId.`;
    }
  };
  const full = render(true);
  return full.length <= BINDING_LINE_MAX ? full : render(false);
}
