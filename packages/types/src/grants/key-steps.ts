/**
 * The New key page's first two steps, as data (key pages plan 447800fe §5.1,
 * decision 68d37853): WHERE a key acts (the pod, one space, one project) and
 * WHO it acts as, then WHAT IT IS FOR (the templates that work there). The
 * remaining steps are `./access-levels.ts` (what it can do) and the name.
 * Every host renders these; none decides them. Pure.
 */

import { allowedQualifiers, parsePermission } from "./grammar.js";
import { isFullAccess, type GrantDraft } from "./draft.js";
import {
  accessFamily,
  setFamilyLevel,
  type KeyScope,
} from "./access-levels.js";
import type { GrantRole } from "./presets.js";
import {
  KEY_DRAFT_STEPS,
  keyDraftFromTemplate,
  setKeyGrant,
  type KeyDraft,
  type KeyDraftStepId,
} from "./key-draft.js";

export type { KeyScope } from "./access-levels.js";

/** The three scopes, in the order the page offers them. Copy beside each. */
export const KEY_SCOPES: readonly {
  readonly id: KeyScope;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "pod",
    label: "The whole pod",
    description: "Anywhere you can reach.",
  },
  { id: "space", label: "One space", description: "Only inside one space." },
  {
    id: "project",
    label: "One project",
    description: "Only what is filed into one project.",
  },
];

/** Where a draft acts, read from its narrowing. */
export function keyScope(grant: GrantDraft): KeyScope {
  if (grant.projectIds && grant.projectIds.length > 0) return "project";
  if (grant.workspaceIds && grant.workspaceIds.length > 0) return "space";
  return "pod";
}

/**
 * Point a draft at a scope: the pod (no narrowing), one space or one project.
 * A project scope also turns Activity off (answer 26: an observation carries
 * no project, so a project-limited key could never post one).
 */
export function setKeyScope(
  draft: KeyDraft,
  scope: KeyScope,
  id: string | null = null
): KeyDraft {
  const grant: GrantDraft = {
    ...draft.grant,
    workspaceIds: scope === "space" && id ? [id] : null,
    projectIds: scope === "project" && id ? [id] : null,
  };
  return setKeyGrant(
    draft,
    scope === "project"
      ? setFamilyLevel(grant, accessFamily("activity"), "off")
      : grant
  );
}

/**
 * Who holds the key: the person (`apiKeys.create`), the pod (a system key,
 * pod-wide) or a service in one space (`adminCreateServiceKey`).
 */
export type KeyHolder = "person" | "system" | "service";

export interface KeyHolderChoice {
  readonly id: KeyHolder;
  readonly label: string;
  readonly description: string;
}

/**
 * The holders a scope offers, the person first: pod → you or the pod; space
 * → you or a service there; project → you only (a system key is pod-wide, a
 * service key belongs to one space).
 */
export function keyHoldersForScope(
  scope: KeyScope
): readonly KeyHolderChoice[] {
  switch (scope) {
    case "pod":
      return [
        {
          id: "person",
          label: "You",
          description: "Acts as you, wherever you can reach.",
        },
        {
          id: "system",
          label: "The pod",
          description:
            "A system key for automation and scripts, listed as System.",
        },
      ];
    case "space":
      return [
        {
          id: "person",
          label: "You, in this space",
          description: "Acts as you, and only in this space.",
        },
        {
          id: "service",
          label: "A service, in this space",
          description:
            "For an outside service (n8n, a site's backend). Listed on this space's keys.",
        },
      ];
    case "project":
      return [
        {
          id: "person",
          label: "You, in this project",
          description: "Acts as you, and only on what is filed into it.",
        },
      ];
  }
}

/** Does any permission post activity (`event.*.create`, `event`, `*`)? */
function postsActivity(permissions: readonly string[]): boolean {
  try {
    const q = allowedQualifiers({ permissions }, "event", "create");
    return q === "all" || q.length > 0;
  } catch {
    return permissions.some((p) => {
      try {
        return parsePermission(p)[0] === "event";
      } catch {
        return false;
      }
    });
  }
}

/**
 * Does a template work at this scope? Its own `scopes` when it declares them;
 * else derived: at project scope, nothing that posts activity (full access
 * included).
 */
export function templateFitsScope(
  template: GrantRole,
  scope: KeyScope
): boolean {
  if (template.scopes) return template.scopes.includes(scope);
  if (scope !== "project") return true;
  return (
    !isFullAccess(template.grant) && !postsActivity(template.grant.permissions)
  );
}

/**
 * Step 2's cards: the templates that work at the scope, and one line for each
 * it hides ("Dev loop poster needs the whole pod or a space").
 */
export function templatesForScope(
  templates: readonly GrantRole[],
  scope: KeyScope
): {
  readonly offered: readonly GrantRole[];
  readonly hidden: readonly {
    readonly template: GrantRole;
    readonly why: string;
  }[];
} {
  const offered: GrantRole[] = [];
  const hidden: { template: GrantRole; why: string }[] = [];
  for (const t of templates) {
    if (templateFitsScope(t, scope)) offered.push(t);
    else hidden.push({ template: t, why: `${t.name} ${needsWords(t, scope)}` });
  }
  return { offered, hidden };
}

function needsWords(t: GrantRole, scope: KeyScope): string {
  const fits = (["pod", "space", "project"] as const).filter(
    (s) => s !== scope && templateFitsScope(t, s)
  );
  const words = fits.map((s) =>
    s === "pod" ? "the whole pod" : s === "space" ? "a space" : "a project"
  );
  return words.length > 0
    ? `needs ${words.join(" or ")}.`
    : "does not work here.";
}

/**
 * Start from a template where the draft already acts: the template's access,
 * kept to what works at the draft's scope (at a project, no Activity).
 */
export function keyDraftFromTemplateAt(
  template: GrantRole,
  base: KeyDraft
): KeyDraft {
  const next = keyDraftFromTemplate(template, base);
  return keyScope(base.grant) === "project"
    ? setKeyGrant(
        next,
        setFamilyLevel(next.grant, accessFamily("activity"), "off")
      )
    : next;
}

/** What the page knows was answered that a draft cannot say by itself. */
export interface KeyStepAnswers {
  /** The person picked a scope (a `?space=` link answers it too). */
  readonly where: boolean;
  /** The person picked a template, or "Something else". */
  readonly purpose: boolean;
}

export interface KeyStepState {
  readonly id: KeyDraftStepId;
  readonly label: string;
  readonly answered: boolean;
  /** The one step open: the first unanswered one (none once all are). */
  readonly open: boolean;
}

/** Each step, answered or not, and the one that is open. */
export function keyStepStates(
  draft: KeyDraft,
  answers: KeyStepAnswers
): readonly KeyStepState[] {
  const answered: Record<KeyDraftStepId, boolean> = {
    where: answers.where,
    purpose: answers.purpose,
    access: draft.grant.permissions.length > 0 && draft.uses.length > 0,
    name: draft.name.trim().length > 0,
  };
  const first = KEY_DRAFT_STEPS.find((s) => !answered[s.id])?.id ?? null;
  return KEY_DRAFT_STEPS.map((s) => ({
    id: s.id,
    label: s.label,
    answered: answered[s.id],
    open: s.id === first,
  }));
}
