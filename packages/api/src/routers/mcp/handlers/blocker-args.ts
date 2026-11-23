/**
 * The blocker-list args of the work doors (`synap_start_session`,
 * `synap_update_session`, `synap_update_track`): what a session or a goal
 * WAITS ON, by kind of blocker. Parsed here once; the edges are written by
 * the dependency doors (`session-blocked-by.ts` for sessions,
 * `services/links/unit-blockers.ts` for an entity or a goal).
 */
import { isUuid } from "@synap-core/types/property-render";

/** At most this many ids per blocker list — the same bound start's `blockedBySessionIds` has. */
export const BLOCKER_IDS_MAX = 20;

/** One blocker-id list arg: absent = [], else at most 20 UUIDs or an error. */
export function readBlockerIds(
  args: Record<string, unknown>,
  key: string,
  noun: string
): string[] | { error: string } {
  const raw = args[key];
  if (raw === undefined || raw === null) return [];
  if (
    !Array.isArray(raw) ||
    raw.length > BLOCKER_IDS_MAX ||
    !raw.every((id) => typeof id === "string" && isUuid(id))
  ) {
    return {
      error: `${key} must be an array of at most ${BLOCKER_IDS_MAX} ${noun} UUIDs — NOTHING WAS CHANGED.`,
    };
  }
  return raw as string[];
}

/** What a session (or a goal) waits on, by kind of blocker. */
const BLOCKER_KINDS = [
  { kind: "session", suffix: "SessionIds", noun: "session" },
  { kind: "entity", suffix: "EntityIds", noun: "entity" },
  { kind: "track", suffix: "TrackIds", noun: "goal" },
] as const;
type BlockerEditKind = (typeof BLOCKER_KINDS)[number]["kind"];
type BlockerEdits = Record<
  BlockerEditKind,
  { add: string[]; remove: string[] }
>;

/**
 * The mid-flight blocker edits on `synap_update_session` (and, for goals,
 * `synap_update_track`): `addBlockedBy<Kind>Ids` / `removeBlockedBy<Kind>Ids`
 * for sessions, entities (a decision) and goals, each an array of UUIDs.
 * Refused whole (nothing changed) when malformed, or when one id is in both
 * lists of a kind: an add and a remove of the same edge in one call has no
 * honest order.
 */
export function parseBlockerEdits(
  args: Record<string, unknown>,
  kinds: readonly BlockerEditKind[] = ["session", "entity", "track"]
): BlockerEdits | { error: string } {
  const out: BlockerEdits = {
    session: { add: [], remove: [] },
    entity: { add: [], remove: [] },
    track: { add: [], remove: [] },
  };
  for (const { kind, suffix, noun } of BLOCKER_KINDS) {
    if (!kinds.includes(kind)) continue;
    const add = readBlockerIds(args, `addBlockedBy${suffix}`, noun);
    if ("error" in add) return add;
    const remove = readBlockerIds(args, `removeBlockedBy${suffix}`, noun);
    if ("error" in remove) return remove;
    const both = add.filter((id) => remove.includes(id));
    if (both.length > 0) {
      return {
        error: `${both.join(", ")} is in both addBlockedBy${suffix} and removeBlockedBy${suffix} — NOTHING WAS CHANGED. Send one of the two.`,
      };
    }
    out[kind] = { add, remove };
  }
  return out;
}

/** Whether a parsed edit set asks for anything. */
export function hasBlockerEdits(edits: BlockerEdits): boolean {
  return Object.values(edits).some(
    (e) => e.add.length > 0 || e.remove.length > 0
  );
}
