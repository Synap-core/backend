/**
 * KeyDraft — the ONE model of the New key page (keys plan §3, Decision 1): the
 * sections in their fixed order, what a key made from the draft can do (in
 * words, with its danger marks), what the mint door would refuse, and the
 * wire shape. Every host renders it (browser and studio through
 * `@synap-core/web`, pod-admin in HeroUI, the CLI's review link); none of
 * them decides any of it.
 *
 * A draft is a GRANT draft (`./draft.ts`: permissions, narrowing, lifetime)
 * plus the key's own fields: its name, a note, where it is used (`uses`,
 * which decide its scopes, `./key-uses.ts`) and the template it started from.
 */

import { GRANT_ACTIONS, parsePermission } from "./grammar.js";
import { grantActionLabel, isQualifiedGrantSubject } from "./catalog.js";
import {
  EMPTY_GRANT_DRAFT,
  MAX_KEY_TTL_DAYS,
  grantLifetime,
  isFullAccess,
  toGrantMintInput,
  validateGrantDraft,
  type GrantDraft,
  type GrantMintInput,
  type GrantProblem,
} from "./draft.js";
import { scopeWithin } from "./algebra.js";
import { applyGrantRole, type GrantRole } from "./presets.js";
import {
  grantHoldsWrite,
  isKeyUseId,
  KEY_USES,
  scopesForKey,
  type KeyUseId,
} from "./key-uses.js";
import {
  FULL_ACCESS_LABEL,
  summarizeGrant,
  type GrantSummary,
  type SummarizeGrantOptions,
} from "./summary.js";
import { resolveKeyUseLabel } from "../vocabulary/index.js";

// ── the page's sections ────────────────────────────────────────────────────

/**
 * The sections, in this order and no other (keys plan §3.2). Titles are
 * product copy. The rail repeats `review` live.
 *
 * EXPAND (key pages plan 447800fe, wave K1): the page is now the four
 * `KEY_DRAFT_STEPS`; a section is a PART inside a step. Kept exported until
 * the web and desktop hosts render the steps (wave K4), then removed.
 */
export const KEY_DRAFT_SECTIONS = [
  { id: "start", label: "Start from" },
  { id: "name", label: "Name and note" },
  { id: "uses", label: "Where it is used" },
  { id: "access", label: "What it may touch" },
  { id: "where", label: "Where" },
  { id: "lifetime", label: "Lifetime" },
  { id: "review", label: "Review" },
] as const;

export type KeyDraftSectionId = (typeof KEY_DRAFT_SECTIONS)[number]["id"];

/**
 * The New key page as four steps that close as they are answered — one page,
 * never a wizard (decision 68d37853, answer 23): where it acts (and who it
 * acts as) → what it is for (a template that works there) → what it can do
 * (families at one level, `./access-levels.ts`; doors and lifetime inside)
 * → its name. `parts` are the sections each step holds. Titles and hints are
 * product copy.
 */
export const KEY_DRAFT_STEPS = [
  {
    id: "where",
    label: "Where it acts",
    hint: "The whole pod, one space or one project.",
    parts: ["where"],
  },
  {
    id: "purpose",
    label: "What it is for",
    hint: "Start from what the key will do.",
    parts: ["start"],
  },
  {
    id: "access",
    label: "What it can do",
    hint: "Each kind of thing at one level.",
    parts: ["access", "uses", "lifetime"],
  },
  {
    id: "name",
    label: "Name it",
    hint: "And note where you will keep it.",
    parts: ["name"],
  },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly parts: readonly KeyDraftSectionId[];
}[];

export type KeyDraftStepId = (typeof KEY_DRAFT_STEPS)[number]["id"];

/** The step a section is part of; `review` is the bar, under every step. */
export function keyDraftStepOf(
  section: KeyDraftSectionId
): KeyDraftStepId | null {
  const step = KEY_DRAFT_STEPS.find((s) =>
    (s.parts as readonly string[]).includes(section)
  );
  return step ? step.id : null;
}

/** The lifetimes offered as choices, in days; "custom" and "never" besides. */
export const KEY_LIFETIME_CHOICES = [1, 30, 90, 365] as const;

// ── the draft ──────────────────────────────────────────────────────────────

export interface KeyDraft {
  /** What the person calls it. Required. */
  readonly name: string;
  /** "Where will you keep it?" — stored with the key. */
  readonly note?: string;
  /** The template it started from (a built-in id or a stored role's id). */
  readonly templateId?: string | null;
  /** Where it is used (`KEY_USES` ids): this decides its scopes. */
  readonly uses: readonly string[];
  /** What it may touch, where, and for how long. */
  readonly grant: GrantDraft;
}

export const EMPTY_KEY_DRAFT: KeyDraft = {
  name: "",
  uses: [],
  grant: EMPTY_GRANT_DRAFT,
};

/** Uses in KEY_USES order, no duplicates; unknown ids kept last (validation reports them). */
function orderUses(uses: readonly string[]): string[] {
  const known = KEY_USES.map((u) => u.id as string).filter((id) =>
    uses.includes(id)
  );
  const unknown = [...new Set(uses.filter((u) => !isKeyUseId(u)))];
  return [...known, ...unknown];
}

/**
 * Start from a template: its permissions, narrowing, lifetime and uses. The
 * name is the template's unless the person already typed one; the note is
 * kept.
 */
export function keyDraftFromTemplate(
  template: GrantRole,
  base: KeyDraft = EMPTY_KEY_DRAFT
): KeyDraft {
  return {
    ...base,
    name: base.name.trim() ? base.name : template.name,
    templateId: template.id,
    uses: orderUses(template.uses ?? base.uses),
    grant: applyGrantRole(base.grant, template),
  };
}

export function setKeyUses(draft: KeyDraft, uses: readonly string[]): KeyDraft {
  return { ...draft, uses: orderUses(uses) };
}

export function setKeyGrant(draft: KeyDraft, grant: GrantDraft): KeyDraft {
  return { ...draft, grant };
}

// ── what it can do ─────────────────────────────────────────────────────────

/**
 * A mark the review shows beside the sentence. `full-access` is always red;
 * `powerful-actions` lists the gate verbs it holds (approve, merge, …);
 * `can-delete` says Edit includes delete (decision 68d37853, answer 24);
 * `never-expires` is a warning.
 */
export type KeyDangerMark =
  | { readonly code: "full-access"; readonly label: string }
  | {
      readonly code: "powerful-actions";
      readonly label: string;
      readonly verbs: readonly string[];
    }
  | { readonly code: "can-delete"; readonly label: string }
  | { readonly code: "never-expires"; readonly label: string };

/** The words of the `can-delete` mark (copy). */
export const KEY_CAN_DELETE_LABEL = "Can delete";

/**
 * The powerful actions section 4 offers after the read/create/update/delete
 * columns (keys plan §3.2): each a gate verb a key holds only when its pattern
 * names it, and each a danger mark (`powerfulVerbs`) once picked.
 */
export interface KeyPowerfulAction {
  readonly pattern: string;
  readonly subject: string;
  readonly verb: string;
}

export const KEY_POWERFUL_ACTIONS: readonly KeyPowerfulAction[] = [
  { pattern: "proposal.approve", subject: "proposal", verb: "approve" },
  { pattern: "entity.*.merge", subject: "entity", verb: "merge" },
  { pattern: "entity.*.archive", subject: "entity", verb: "archive" },
  { pattern: "entity.*.purge", subject: "entity", verb: "purge" },
];

/** The deletes and gate verbs a permission list holds, in first-seen order. */
export function powerfulVerbs(permissions: readonly string[]): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    if (!out.includes(v)) out.push(v);
  };
  for (const p of permissions) {
    let segs: string[];
    try {
      segs = parsePermission(p);
    } catch {
      continue;
    }
    if (segs[0] === "*") continue; // full access has its own mark
    const action = segs[isQualifiedGrantSubject(segs[0]) ? 2 : 1];
    if (action === undefined || action === "*") add("delete");
    else if (action === "delete") add("delete");
    else if (!(GRANT_ACTIONS as readonly string[]).includes(action))
      add(action);
  }
  return out;
}

export interface KeyDescription {
  /** What it may touch, where and when (`summarizeGrant`). */
  readonly summary: GrantSummary;
  /** Where it is used, in words, in KEY_USES order. */
  readonly uses: readonly { readonly id: string; readonly label: string }[];
  /** The scopes the mint door will derive for it. */
  readonly scopes: readonly string[];
  /** Does the grant hold any write (so write doors are opened)? */
  readonly writes: boolean;
  readonly marks: readonly KeyDangerMark[];
  /** One line: where it is used · what · where · when. */
  readonly sentence: string;
}

export function describeKey(
  draft: KeyDraft,
  opts: SummarizeGrantOptions = {}
): KeyDescription {
  const summary = summarizeGrant(draft.grant, opts);
  const uses = orderUses(draft.uses).map((id) => ({
    id,
    label: resolveKeyUseLabel(id),
  }));
  const marks: KeyDangerMark[] = [];
  if (isFullAccess(draft.grant))
    marks.push({ code: "full-access", label: FULL_ACCESS_LABEL });
  const all = powerfulVerbs(draft.grant.permissions);
  const verbs = all.filter((v) => v !== "delete");
  if (verbs.length > 0)
    marks.push({
      code: "powerful-actions",
      label: `Powerful actions: ${verbs.map(grantActionLabel).join(", ")}`,
      verbs,
    });
  if (all.includes("delete"))
    marks.push({ code: "can-delete", label: KEY_CAN_DELETE_LABEL });
  if (grantLifetime(draft.grant).kind === "never")
    marks.push({ code: "never-expires", label: "Never expires" });
  const useWords = uses.map((u) => u.label).join(", ");
  return {
    summary,
    uses,
    scopes: scopesForKey({
      uses: draft.uses,
      permissions: draft.grant.permissions,
    }),
    writes: grantHoldsWrite(draft.grant.permissions),
    marks,
    sentence: useWords ? `${useWords} · ${summary.sentence}` : summary.sentence,
  };
}

// ── what the mint door would refuse ────────────────────────────────────────

/**
 * The most a draft may be: a template a CLI request named (plus the space it
 * asked for). The reviewer may narrow it, never widen it.
 */
export interface KeyCeiling {
  readonly grant: GrantDraft;
  readonly uses: readonly string[];
}

export type KeyDraftProblem =
  | { readonly code: "no-name" }
  | { readonly code: "no-uses" }
  | { readonly code: "unknown-use"; readonly use: string }
  | { readonly code: "grant"; readonly problem: GrantProblem }
  | {
      readonly code: "wider-than-ceiling";
      readonly axis: "permissions" | "uses" | "lifetime";
    };

export type KeyDraftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly KeyDraftProblem[] };

/** Is lifetime `inner` at most `outer`? Never is the longest. */
function lifetimeWithin(inner: GrantDraft, outer: GrantDraft): boolean {
  const i = grantLifetime(inner);
  const o = grantLifetime(outer);
  if (o.kind === "never") return true;
  return i.kind === "days" && i.days <= o.days;
}

/** Everything the mint (or the request's approval) would refuse. */
export function validateKeyDraft(
  draft: KeyDraft,
  opts: { readonly ceiling?: KeyCeiling } = {}
): KeyDraftValidation {
  const problems: KeyDraftProblem[] = [];
  if (!draft.name.trim()) problems.push({ code: "no-name" });
  if (draft.uses.length === 0) problems.push({ code: "no-uses" });
  for (const use of new Set(draft.uses))
    if (!isKeyUseId(use)) problems.push({ code: "unknown-use", use });
  const grant = validateGrantDraft(draft.grant);
  if (!grant.ok)
    for (const problem of grant.problems)
      problems.push({ code: "grant", problem });
  const { ceiling } = opts;
  if (ceiling) {
    // A malformed permission is already a problem above; the ceiling can only
    // be compared on a grant that parses.
    if (grant.ok && !scopeWithin(draft.grant, ceiling.grant))
      problems.push({ code: "wider-than-ceiling", axis: "permissions" });
    if (!draft.uses.every((u) => ceiling.uses.includes(u)))
      problems.push({ code: "wider-than-ceiling", axis: "uses" });
    if (!lifetimeWithin(draft.grant, ceiling.grant))
      problems.push({ code: "wider-than-ceiling", axis: "lifetime" });
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Where a problem is fixed, and how it reads there: ONE wording for every
 * host (the New key page, the request Review page, the approval door's
 * refusal). `section` is the section the person goes back to, `step` the step
 * that holds it.
 */
export function describeKeyProblem(p: KeyDraftProblem): {
  readonly section: KeyDraftSectionId;
  readonly step: KeyDraftStepId;
  readonly text: string;
} {
  const found = problemSection(p);
  return { ...found, step: keyDraftStepOf(found.section) ?? "access" };
}

function problemSection(p: KeyDraftProblem): {
  readonly section: KeyDraftSectionId;
  readonly text: string;
} {
  switch (p.code) {
    case "no-name":
      return { section: "name", text: "Name the key." };
    case "no-uses":
      return { section: "uses", text: "Pick at least one place it is used." };
    case "unknown-use":
      return {
        section: "uses",
        text: `"${p.use}" is not a place a key can be used.`,
      };
    case "wider-than-ceiling":
      return {
        section: p.axis === "permissions" ? "access" : p.axis,
        text: "Wider than the request allows. Narrow it, or ask for a new request.",
      };
    case "grant":
      switch (p.problem.code) {
        case "no-permissions":
          return {
            section: "access",
            text: "Pick at least one thing it may touch.",
          };
        case "invalid-lifetime":
          return {
            section: "lifetime",
            text: `Pick a lifetime from 1 to ${MAX_KEY_TTL_DAYS} days.`,
          };
        default:
          return { section: "access", text: p.problem.message };
      }
  }
}

// ── the mint wire shape ────────────────────────────────────────────────────

export interface KeyMintInput extends GrantMintInput {
  name: string;
  uses: KeyUseId[];
  note?: string;
  templateId?: string;
}

/**
 * The `apiKeys.create` input for this draft. It carries `uses`, never scopes:
 * the door derives them. Unknown use ids are dropped here (validation reports
 * them first).
 */
export function toKeyMintInput(draft: KeyDraft): KeyMintInput {
  const out: KeyMintInput = {
    name: draft.name.trim(),
    uses: orderUses(draft.uses).filter(isKeyUseId),
    ...toGrantMintInput(draft.grant),
  };
  if (draft.note?.trim()) out.note = draft.note.trim();
  if (draft.templateId) out.templateId = draft.templateId;
  return out;
}
