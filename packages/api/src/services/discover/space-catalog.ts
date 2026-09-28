/**
 * The spaces an agent could ROUTE work to, as searchable rows — the `spaces`
 * catalog of `findByIntent` (`services/capabilities/find-intent.ts`).
 *
 * WHY (2026-09-28). An agent asked to "store brand assets" filed generic
 * `file` entities: nothing it searched named the Brand Library space or its
 * `brand-*` kinds. `find` searched verbs, intents and playbooks — never the
 * spaces the pod is organised into.
 *
 * READ ONLY what the space itself declares; no index, no LLM:
 *   - `name`
 *   - `purpose` — `resolveSpacePurpose` (the ONE rule orient, the brief and
 *     diagnose apply), as the one-line `spacePurposeLine`
 *   - `persona` — `settings.onboarding.framing`, one line
 *   - `kinds`   — the onboarding `collect` profile slugs first (the template's
 *     own order: root kind first), then kinds this space OWNS
 *     (`profiles.workspace_id`, `profile_kind = 'kind'`)
 *
 * MEMBERSHIP FLOOR: the same predicate `synap_find` applies to its lens
 * (`verifyWorkspaceAccess` = a `workspace_members` row), in its set form
 * `getUserMemberWorkspaceIds`. Archived spaces are not routing targets.
 */

import {
  db,
  workspaces,
  profiles,
  and,
  eq,
  inArray,
  isNull,
} from "@synap/database";
import { getUserMemberWorkspaceIds } from "../../routers/hub-protocol/rest/_shared.js";
import { spacePurposeLine } from "./space-brief.js";
import { loadEntityUsage } from "./usage-aggregate.js";

/** One-line cap for a space's persona in a search row. */
export const SPACE_PERSONA_LINE_CAP = 120;

export interface SpaceCandidate {
  workspaceId: string;
  name: string;
  purpose?: string;
  persona?: string;
  /** Collect slugs (template order) then owned kind slugs, deduped. */
  kinds: string[];
}

function oneLine(value: unknown, cap: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** PURE: one row from the workspace row + the kinds it owns. */
export function toSpaceCandidate(
  row: {
    id: string;
    name: string;
    description: string | null;
    settings: unknown;
  },
  ownedKinds: readonly string[]
): SpaceCandidate {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const onboarding = (settings.onboarding ?? {}) as Record<string, unknown>;
  const collect = Array.isArray(onboarding.collect)
    ? (onboarding.collect as Array<Record<string, unknown>>).flatMap((c) =>
        typeof c?.profileSlug === "string" && c.profileSlug
          ? [c.profileSlug]
          : []
      )
    : [];
  const purpose = spacePurposeLine(row.description, onboarding);
  const persona = oneLine(onboarding.framing, SPACE_PERSONA_LINE_CAP);
  return {
    workspaceId: row.id,
    name: row.name,
    ...(purpose ? { purpose } : {}),
    ...(persona ? { persona } : {}),
    kinds: [...new Set([...collect, ...ownedKinds])],
  };
}

/**
 * The caller's member spaces as search rows. Throws on a failed read — the
 * caller marks the catalog unavailable; it is never folded into "no spaces".
 */
export async function listSpaceCandidates(
  userId: string
): Promise<SpaceCandidate[]> {
  const ids = await getUserMemberWorkspaceIds(userId);
  if (ids.length === 0) return [];
  const [rows, owned] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
        settings: workspaces.settings,
      })
      .from(workspaces)
      .where(and(inArray(workspaces.id, ids), isNull(workspaces.archivedAt))),
    db
      .select({ workspaceId: profiles.workspaceId, slug: profiles.slug })
      .from(profiles)
      .where(
        and(
          inArray(profiles.workspaceId, ids),
          eq(profiles.profileKind, "kind")
        )
      ),
  ]);
  const ownedByWs = new Map<string, string[]>();
  for (const p of owned) {
    if (!p.workspaceId) continue;
    const list = ownedByWs.get(p.workspaceId) ?? [];
    list.push(p.slug);
    ownedByWs.set(p.workspaceId, list);
  }
  return rows.map((r) =>
    toSpaceCandidate(r, (ownedByWs.get(r.id) ?? []).sort())
  );
}

// ── ask's spaces hint ────────────────────────────────────────────────────────

/** Spaces an ask hint lists at most. */
export const ASK_SPACES_HINT_LIMIT = 3;

export interface AskSpaceHint {
  workspaceId: string;
  name: string;
  /** One-line purpose (`spacePurposeLine`). Absent when the space has none. */
  purpose?: string;
  /** The asked-about kinds this space HOLDS, with its own entity counts. */
  kinds: Array<{ slug: string; count: number }>;
}

/**
 * The space(s) holding the kinds a question is about — `ask`'s routing hint.
 * `matches: []` = read, and no member space holds any of those kinds.
 * `{ status: "unavailable" }` = the read failed — never folded into "none".
 */
export type AskSpacesHint =
  { matches: AskSpaceHint[] } | { status: "unavailable" };

/**
 * Map understood profile slugs to the member spaces holding entities of them,
 * through THE usage aggregate (`loadEntityUsage`: same owner floor, same
 * counts orient and grounding report). Ranked by how many of the asked-about
 * entities each space holds. Returns `undefined` when there are no slugs —
 * nothing was understood, so there is nothing to route.
 */
export async function suggestSpacesForKinds(
  userId: string,
  slugs: readonly string[]
): Promise<AskSpacesHint | undefined> {
  const wanted = new Set(slugs.filter(Boolean));
  if (wanted.size === 0) return undefined;
  try {
    const ids = await getUserMemberWorkspaceIds(userId);
    const usage = await loadEntityUsage({ userId, workspaceIds: ids });
    const byWs = new Map<string, Map<string, number>>();
    for (const row of usage) {
      if (!row.workspaceId || !row.type || !wanted.has(row.type)) continue;
      if (row.count <= 0) continue;
      const kinds = byWs.get(row.workspaceId) ?? new Map<string, number>();
      kinds.set(row.type, (kinds.get(row.type) ?? 0) + row.count);
      byWs.set(row.workspaceId, kinds);
    }
    const total = (m: Map<string, number>) =>
      [...m.values()].reduce((a, b) => a + b, 0);
    const top = [...byWs.entries()]
      .sort((a, b) => total(b[1]) - total(a[1]))
      .slice(0, ASK_SPACES_HINT_LIMIT);
    if (top.length === 0) return { matches: [] };
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
        settings: workspaces.settings,
      })
      .from(workspaces)
      .where(
        and(
          inArray(
            workspaces.id,
            top.map(([id]) => id)
          ),
          isNull(workspaces.archivedAt)
        )
      );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return {
      matches: top.flatMap(([id, kinds]) => {
        const row = rowById.get(id);
        if (!row) return [];
        const onboarding = (row.settings as Record<string, unknown> | null)
          ?.onboarding;
        const purpose = spacePurposeLine(row.description, onboarding);
        return [
          {
            workspaceId: id,
            name: row.name,
            ...(purpose ? { purpose } : {}),
            kinds: [...kinds.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([slug, count]) => ({ slug, count })),
          },
        ];
      }),
    };
  } catch {
    return { status: "unavailable" };
  }
}
