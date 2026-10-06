/**
 * THE space brief — what an agent needs to WORK inside one workspace (space):
 * what it is for, the voice to adopt, the domain expertise it declares, what
 * to collect, the kinds that live here, and the playbooks it runs.
 *
 * WHY (2026-09-28). An agent asked to store brand assets on the pod filed
 * generic `file` entities, because nothing it read told it that Brand Library
 * has `brand-asset` / `brand-color` / `brand-font` kinds. `set_workspace_focus`
 * answered "Focused on Brand Library" and nothing else; light orient carried
 * only `onboarding.goal`; and pinned `startHere.topKinds` ranked pod-wide
 * counts, so the space's own kinds were crowded out.
 *
 * ONE assembly, served by every door that pins a space (`set_workspace_focus`,
 * `orient` with a workspaceId). It reuses the doors orient already reads
 * through: the workspace row's authored purpose (`resolveSpacePurpose`, the same
 * rule orient's workspace DTO and diagnose apply), the stored brief read
 * through THE reader (`readSpaceBrief`, `@synap-core/types/space-brief`), the
 * lens-ranked profile listing (`readRankedLensProfiles`, shared with
 * `startHere.topKinds`), and the ONE playbook list door.
 *
 * Compact by construction: empty sections are OMITTED (no nulls, no `[]`),
 * lists are capped with a total. A section that could not be READ is
 * `{ status: "unavailable" }` — never folded into "this space has none".
 */

import {
  db,
  workspaces,
  propertyDefs,
  eq,
  and,
  isNotNull,
} from "@synap/database";
import {
  readSpaceBrief,
  resolveAuthoredDescription,
  resolveSpacePurpose as resolveSpacePurposeLeaf,
  type SpaceBriefSkillRef,
} from "@synap-core/types/space-brief";
import type { HubProtocolCaller } from "../../routers/hub-protocol/rest/_shared.js";
import { resolveProfileDescription } from "../../utils/profile-presentation.js";
import { profileDisplayName, type RankedProfile } from "./profile-ranking.js";
import { readRankedLensProfiles, type LensProfile } from "./start-here.js";

/** One-line cap for a kind / playbook description in the brief. */
export const BRIEF_LINE_CAP = 120;
/** Authored prose cap (purpose, persona, an expertise item, the bar). */
export const BRIEF_PROSE_CAP = 240;
/** Kinds listed before `keyKindsTotal` says how many more exist. */
export const BRIEF_KIND_CAP = 12;
/** Playbooks listed before `total` says how many more exist. */
export const BRIEF_PLAYBOOK_CAP = 8;
/**
 * HARD cap on the serialized brief (UTF-8 bytes). It rides on `orient` and on
 * every `set_workspace_focus` reply, so it must stay a briefing, not the
 * template. Over budget, sections are shed in `TRIM_LADDER` order and NAMED in
 * `trimmed` — the full onboarding spec stays one call away (orient
 * detail:'full').
 *
 * 2 KB (founder decision, 2026-09-28; was 1536). Re-measured with W3's
 * steady-state fields (purpose, anchors, rule refs) through this assembly
 * from the REAL templates (worst case: every template kind owned, every
 * template playbook active, root anchor resolved, every rule installed) —
 * `space-brief.templates.test.ts` asserts all 26 briefed templates fit:
 * Brand Library 2024 B (sheds starters, blind spots, collect prose; keeps
 * purpose, persona, anchors, rule keys, every kind's prose), CRM 1789 B,
 * largest content-studio 2030 B.
 */
export const BRIEF_BUDGET_BYTES = 2048;

interface Unavailable {
  status: "unavailable";
}
const UNAVAILABLE: Unavailable = { status: "unavailable" };

export interface SpaceBriefKind {
  slug: string;
  /** Omitted when it only restates the slug ("brand-asset" → "Brand Asset"). */
  name?: string;
  /** Entities of this kind IN THIS SPACE (never the pod-wide total). */
  entityCount: number;
  description?: string;
}

/**
 * The BUILT brief — the compact briefing an agent receives when it pins a
 * space (`set_workspace_focus`, pinned `orient`). Not the stored brief: that
 * is `SpaceBrief` in `@synap-core/types/space-brief`, read through
 * `readSpaceBrief`; this is assembled FROM it plus live reads (kinds,
 * playbooks), capped at `BRIEF_BUDGET_BYTES`.
 */
export interface BuiltSpaceBrief {
  workspaceId: string;
  name: string;
  /** `resolveSpacePurpose` — the ONE ladder every door uses. */
  purpose?: string;
  /** `onboarding.framing` — the voice/expertise to adopt here. */
  persona?: string;
  /**
   * What to read first. `root` = THE entity this space is about (its id once
   * the pod resolved it, else the kind to read); `context` = kinds to read too.
   */
  anchors?: {
    root?: { kind: string; entityId?: string };
    context?: string[];
  };
  /** Keys of the rules this space's template installed (the brief's refs). */
  rules?: string[];
  /**
   * Skills this space declares. An `always` one is already prepended to a
   * session started here; the list is how the agent knows the rest.
   */
  skills?: SpaceBriefSkillRef[];
  expertise?: { starters?: string[]; blindSpots?: string[]; bar?: string };
  /** What this space wants filled: kind + what to capture. */
  collect?: Array<{ kind: string; what?: string; cardinality?: string }>;
  /** The kinds that live here — write THESE, not a generic kind. */
  keyKinds?: SpaceBriefKind[] | Unavailable;
  /** Present only when `keyKinds` was capped. */
  keyKindsTotal?: number;
  playbooks?:
    | {
        /**
         * Emptied (total kept) before purpose, persona, root anchor and kinds.
         * Emptied, never removed: published clients read `items.length`.
         */
        items: Array<{ id: string; name: string; description?: string }>;
        total: number;
      }
    | Unavailable;
  /** Sections shed to fit `BRIEF_BUDGET_BYTES`, in the order they were cut. */
  trimmed?: string[];
  more: string;
}

/** Whitespace-collapsed, trimmed, capped — or undefined when empty. */
function line(value: unknown, cap: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

function lines(value: unknown, cap: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => line(v, cap)).filter((v): v is string => !!v);
  return out.length ? out : undefined;
}

/**
 * The authored-description check and THE purpose ladder live in the leaf
 * (`@synap-core/types/space-brief`) so the browser and relay apply the same
 * rule: authored description (never a `Domain: x` placeholder) >
 * brief.purpose > onboarding.goal. Re-exported here for the pod's callers.
 */
export { resolveAuthoredDescription };

/**
 * THE purpose ladder — a thin call into the leaf. Every pod door that says
 * what a space is for goes through this (tripwire:
 * `__tripwires__/space-purpose-one-ladder.test.ts`).
 */
export function resolveSpacePurpose(
  description: unknown,
  settings: unknown
): string | null {
  return resolveSpacePurposeLeaf({ description, settings });
}

/** One-line cap for a space's purpose in a LIST of spaces (orient light, find). */
export const SPACE_PURPOSE_LINE_CAP = 120;

/**
 * A space's purpose as ONE list line: `resolveSpacePurpose`, whitespace
 * collapsed, clipped to `SPACE_PURPOSE_LINE_CAP`. The full purpose rides in
 * the pinned space's brief; a list of 13 spaces at 220 chars each was ~2.9 KB.
 */
export function spacePurposeLine(
  description: unknown,
  settings: unknown
): string | undefined {
  return line(
    resolveSpacePurpose(description, settings),
    SPACE_PURPOSE_LINE_CAP
  );
}

export interface SpaceBriefWorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  settings: unknown;
}

/** Profile ids this workspace extends with an overlay property def. */
async function readOverlayProfileIds(
  workspaceId: string
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ profileId: propertyDefs.profileId })
    .from(propertyDefs)
    .where(
      and(
        eq(propertyDefs.workspaceId, workspaceId),
        isNotNull(propertyDefs.profileId)
      )
    );
  return new Set(rows.flatMap((r) => (r.profileId ? [r.profileId] : [])));
}

/**
 * PURE: the kinds that live in this space, from the lens-ranked listing.
 * A kind belongs when this workspace OWNS it, OVERLAYS it, or HOLDS entities
 * of it. Order: the onboarding `collect` order first (templates list the root
 * kind first — Brand Library's `brand-identity`), then entity count, then the
 * shared usage rank.
 */
export function selectKeyKinds(
  ranked: ReadonlyArray<RankedProfile<LensProfile>>,
  workspaceId: string,
  overlayProfileIds: ReadonlySet<string>,
  collectOrder: readonly string[]
): { kinds: SpaceBriefKind[]; total: number } {
  const order = (slug: string) => {
    const i = collectOrder.indexOf(slug);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const belongs = ranked.filter((r) => {
    if ((r.profile.profileKind ?? "kind") !== "kind") return false;
    return (
      r.profile.workspaceId === workspaceId ||
      (!!r.profile.id && overlayProfileIds.has(r.profile.id)) ||
      r.entityCount > 0
    );
  });
  belongs.sort(
    (a, b) =>
      order(a.profile.slug) - order(b.profile.slug) ||
      b.entityCount - a.entityCount ||
      a.rank - b.rank
  );
  return {
    total: belongs.length,
    kinds: belongs.slice(0, BRIEF_KIND_CAP).map((r) => {
      const description = line(
        resolveProfileDescription(r.profile),
        BRIEF_LINE_CAP
      );
      const name = profileDisplayName(r.profile);
      const restatesSlug =
        name.toLowerCase() === r.profile.slug.replace(/[-_]+/g, " ");
      return {
        slug: r.profile.slug,
        ...(restatesSlug ? {} : { name }),
        entityCount: r.entityCount,
        ...(description ? { description } : {}),
      };
    }),
  };
}

async function readSpacePlaybooks(p: {
  userId: string;
  scopes: string[];
  workspaceId: string;
}): Promise<BuiltSpaceBrief["playbooks"]> {
  try {
    const { listPlaybooksDoor } =
      await import("../../routers/hub-protocol/playbook-doors.js");
    // The ONE list door (visibility + lens). It narrows to this workspace
    // PLUS pod-wide rows; the brief keeps only this space's own.
    const { playbooks } = await listPlaybooksDoor(
      { userId: p.userId, scopes: p.scopes },
      { workspaceId: p.workspaceId, status: "active", limit: 100 }
    );
    const own = playbooks.filter((pb) => pb.workspaceId === p.workspaceId);
    if (own.length === 0) return undefined;
    return {
      total: own.length,
      items: own.slice(0, BRIEF_PLAYBOOK_CAP).map((pb) => {
        const description = line(pb.description, BRIEF_LINE_CAP);
        return {
          id: pb.id,
          name: pb.name,
          ...(description ? { description } : {}),
        };
      }),
    };
  } catch {
    return UNAVAILABLE;
  }
}

export const briefBytes = (b: unknown): number =>
  Buffer.byteLength(JSON.stringify(b), "utf8");

/**
 * What to shed, least load-bearing first. The kinds that live here are the
 * brief's reason to exist (the agent that filed brand assets as `file` lacked
 * exactly them), so they go LAST, and only their prose before their names.
 */
const shortenKindDescriptions = (
  b: BuiltSpaceBrief,
  cap: number
): boolean => {
  const k = b.keyKinds;
  if (!Array.isArray(k)) return false;
  let changed = false;
  for (const kind of k) {
    if (kind.description && kind.description.length > cap) {
      kind.description = `${kind.description.slice(0, cap - 1)}…`;
      changed = true;
    }
  }
  return changed;
};

const TRIM_LADDER: Array<[string, (b: BuiltSpaceBrief) => boolean]> = [
  [
    "expertise.starters",
    (b) => !!b.expertise?.starters && (delete b.expertise.starters, true),
  ],
  [
    "expertise.blindSpots",
    (b) => !!b.expertise?.blindSpots && (delete b.expertise.blindSpots, true),
  ],
  [
    "collect.what",
    (b) =>
      !!b.collect?.some((c) => c.what) &&
      (b.collect.forEach((c) => delete c.what), true),
  ],
  [
    "playbooks.description",
    (b) => {
      const pb = b.playbooks;
      if (!pb || "status" in pb || !pb.items.some((i) => i.description))
        return false;
      pb.items.forEach((i) => delete i.description);
      return true;
    },
  ],
  ["expertise", (b) => !!b.expertise && (delete b.expertise, true)],
  // keyKinds already follow collect's order; the list itself is the cheap half.
  ["collect", (b) => !!b.collect && (delete b.collect, true)],
  [
    "anchors.context",
    (b) => !!b.anchors?.context && (delete b.anchors.context, true),
  ],
  // Rule keys name rules the pod already applies; a list call re-reads them.
  ["rules", (b) => !!b.rules && (delete b.rules, true)],
  // The playbook LIST goes before purpose, persona, the root anchor and the
  // kinds (founder order 2026-09-28): its `total` stays, so the agent knows
  // to call list_playbooks. `items: []`, not deleted — synap-cli <= de24716
  // reads `playbooks.items.length` unguarded.
  [
    "playbooks.items",
    (b) => {
      const pb = b.playbooks;
      if (!pb || "status" in pb || pb.items.length === 0) return false;
      pb.items = [];
      return true;
    },
  ],
  ["keyKinds.description:60", (b) => shortenKindDescriptions(b, 60)],
  ["persona", (b) => !!b.persona && (delete b.persona, true)],
  // ── LAST to go, deliberately ─────────────────────────────────────────────
  // A space's DECLARED SKILLS are not a re-readable convenience like `rules`
  // (whose rows the pod applies anyway): they are what makes the space work,
  // and BOTH readers of this brief — the CLI's `orient` and the IS turn, which
  // prepends the `always` ones — read THIS object. Shedding them here does not
  // drop a reminder, it drops the feature: the skill is linked, and nothing
  // shows it. So they outlive prose, lists and persona in the budget fight.
  //
  // (Measured 2026-10-06: Brand's brief TRIMS — it reaches the `rules` rung at
  // 1895 B. With `skills` immediately after `rules`, a linked skill was shed in
  // exactly the spaces that needed it.)
  ["skills", (b) => !!b.skills && (delete b.skills, true)],
];

/** Shed sections until the brief fits; the last resort drops list tails. */
export function fitBrief(
  brief: BuiltSpaceBrief,
  budget = BRIEF_BUDGET_BYTES
): BuiltSpaceBrief {
  const b = structuredClone(brief);
  const trimmed: string[] = [];
  const size = () => briefBytes({ ...b, trimmed });
  for (const [name, shed] of TRIM_LADDER) {
    if (size() <= budget) break;
    if (shed(b)) trimmed.push(name);
  }
  // Last resort, one item at a time from the tail: kind prose, then list
  // tails (keeping their true totals).
  while (size() > budget) {
    const described = Array.isArray(b.keyKinds)
      ? b.keyKinds.filter((k) => k.description)
      : [];
    if (described.length) {
      delete described[described.length - 1]!.description;
      if (!trimmed.includes("keyKinds.description"))
        trimmed.push("keyKinds.description");
      continue;
    }
    const k = b.keyKinds;
    if (Array.isArray(k) && k.length > 1) {
      b.keyKindsTotal = b.keyKindsTotal ?? k.length;
      k.pop();
      if (!trimmed.includes("keyKinds.items")) trimmed.push("keyKinds.items");
      continue;
    }
    break;
  }
  if (trimmed.length) {
    // Keep `more` last on the wire.
    const { more, ...rest } = b;
    return { ...rest, trimmed, more };
  }
  return b;
}

const MORE =
  "More: list_playbooks, list_profiles (fields: get_entity), load_skill; " +
  "whole onboarding spec: orient detail:'full'. Tool names are stems.";

/**
 * Build the brief for ONE space the caller may already read. Access is the
 * CALLER's job (orient rejects an inaccessible pin; focus resolves among the
 * user's own workspaces) — this never widens it: kinds come from the caller's
 * own listing, counts from the owner-floored aggregate, playbooks from the
 * visibility-floored door.
 *
 * Returns `{ status: "unavailable" }` when the workspace row itself could not
 * be read — the whole brief rests on it.
 */
export async function buildSpaceBrief(p: {
  caller: HubProtocolCaller;
  userId: string;
  scopes: string[];
  workspaceId: string;
  /** The row, when the caller already loaded it (orient does). */
  workspace?: SpaceBriefWorkspaceRow;
  /** The lens listing, when the caller already started reading it. */
  ranked?: Promise<Array<RankedProfile<LensProfile>>>;
}): Promise<BuiltSpaceBrief | Unavailable> {
  let row = p.workspace;
  try {
    if (!row) {
      [row] = await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          description: workspaces.description,
          settings: workspaces.settings,
        })
        .from(workspaces)
        .where(eq(workspaces.id, p.workspaceId))
        .limit(1);
    }
  } catch {
    return UNAVAILABLE;
  }
  if (!row) return UNAVAILABLE;

  // THE reader: malformed parts read as absent, never half-trusted.
  const stored = readSpaceBrief(row.settings) ?? {};
  const collect = (stored.collect ?? []).map((c) => {
    const what = line(c.what, BRIEF_LINE_CAP);
    return {
      kind: c.profileSlug,
      ...(what ? { what } : {}),
      ...(c.cardinality ? { cardinality: c.cardinality } : {}),
    };
  });

  const starters = lines(stored.expertise?.starters, BRIEF_PROSE_CAP);
  const blindSpots = lines(stored.expertise?.blindSpots, BRIEF_PROSE_CAP);
  const bar = line(stored.expertise?.bar, BRIEF_PROSE_CAP);
  const expertise =
    starters || blindSpots || bar
      ? {
          ...(starters ? { starters } : {}),
          ...(blindSpots ? { blindSpots } : {}),
          ...(bar ? { bar } : {}),
        }
      : undefined;

  const rootAnchor = stored.anchors?.find((a) => a.role === "root");
  const contextKinds = [
    ...new Set(
      (stored.anchors ?? [])
        .filter((a) => a.role === "context")
        .map((a) => a.profileSlug)
    ),
  ];
  const anchors =
    rootAnchor || contextKinds.length
      ? {
          ...(rootAnchor
            ? {
                root: {
                  kind: rootAnchor.profileSlug,
                  ...(rootAnchor.entityId
                    ? { entityId: rootAnchor.entityId }
                    : {}),
                },
              }
            : {}),
          ...(contextKinds.length ? { context: contextKinds } : {}),
        }
      : undefined;
  const rules = stored.rules?.map((r) => r.key);
  const skills = stored.skills;

  const [keyKinds, playbooks] = await Promise.all([
    (async () => {
      try {
        const [ranked, overlays] = await Promise.all([
          p.ranked ??
            readRankedLensProfiles({
              caller: p.caller,
              userId: p.userId,
              workspaceId: p.workspaceId,
            }),
          readOverlayProfileIds(p.workspaceId),
        ]);
        return selectKeyKinds(
          ranked,
          p.workspaceId,
          overlays,
          collect.map((c) => c.kind)
        );
      } catch {
        return UNAVAILABLE;
      }
    })(),
    readSpacePlaybooks({
      userId: p.userId,
      scopes: p.scopes,
      workspaceId: p.workspaceId,
    }),
  ]);

  const purpose = line(
    resolveSpacePurpose(row.description, row.settings),
    BRIEF_PROSE_CAP
  );
  const persona = line(stored.framing, BRIEF_PROSE_CAP);

  return fitBrief({
    workspaceId: row.id,
    name: row.name,
    ...(purpose ? { purpose } : {}),
    ...(persona ? { persona } : {}),
    ...(anchors ? { anchors } : {}),
    ...(rules?.length ? { rules } : {}),
    ...(skills?.length ? { skills } : {}),
    ...(expertise ? { expertise } : {}),
    ...(collect.length ? { collect } : {}),
    ...("status" in keyKinds
      ? { keyKinds }
      : keyKinds.kinds.length
        ? {
            keyKinds: keyKinds.kinds,
            ...(keyKinds.total > keyKinds.kinds.length
              ? { keyKindsTotal: keyKinds.total }
              : {}),
          }
        : {}),
    ...(playbooks ? { playbooks } : {}),
    more: MORE,
  });
}
