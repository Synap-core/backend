/**
 * Team roster context for capture.structure.
 *
 * When structuring a capture in a workspace, inject known team people
 * (names / emails / handles / person entity ids) so the LLM prefers
 * link-not-create and never invents teammates as new contacts.
 *
 * Best-effort: callers MUST wrap in try/catch — never fail structure on roster
 * errors. Caps membership at MAX_TEAM_ROSTER so the instruction block stays
 * short enough for the structure prompt budget.
 */

import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import {
  entities,
  entityIdentitySignals,
  normalizeIdentitySignal,
  userExternalIdSignal,
  users,
  workspaceMembers,
} from "@synap/database";
import type { getDb } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "team-roster-context" });

/** Same handle capture / repos use (`getDb()` / `db`). */
type Db = Awaited<ReturnType<typeof getDb>>;

/** Soft cap — keeps the structure prompt block bounded. */
export const MAX_TEAM_ROSTER = 40;

export interface TeamRosterMemberLine {
  /** Display name (user name, else email, else "Member"). */
  displayName: string;
  email?: string | null;
  /** Matched person entity id when known. */
  personId?: string | null;
}

export interface TeamRosterContext {
  /** Names/aliases/handles to merge into existingEntityNames (dedup hints). */
  names: string[];
  /** Free-text block for structure instructions, or null when empty. */
  instructionBlock: string | null;
  /**
   * Per-member lines used to build the instruction block. Callers that surface
   * this to agents (orient) MUST strip `email` — keep names/ids only.
   */
  members: TeamRosterMemberLine[];
}

/**
 * PURE: format the OUR TEAM instruction block.
 * Returns null when `members` is empty so callers can skip merging.
 *
 * Privacy: do NOT put raw emails in the LLM prompt (egress). Emails still help
 * backend/Typesense via `names[]` / person properties; the block uses display
 * name + optional person id only.
 */
export function formatTeamRosterBlock(
  members: TeamRosterMemberLine[]
): string | null {
  if (members.length === 0) return null;
  const lines = members.map((m) => {
    const idPart = m.personId ? ` [person:${m.personId}]` : "";
    return `- ${m.displayName}${idPart}`;
  });
  return [
    "OUR TEAM (internal — resolve/reuse these people by name/id; do NOT create new contact/client entities for them):",
    ...lines,
  ].join("\n");
}

function pushUnique(set: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const t = value.trim();
  if (t) set.add(t);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function propertiesRecord(properties: unknown): Record<string, unknown> {
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    return properties as Record<string, unknown>;
  }
  return {};
}

/**
 * Load known team people for a workspace and produce capture structure hints.
 *
 * Lookup order per human member (best-effort):
 *   1. external_id signal `user:<memberUserId>` (team-person-bridge)
 *   2. email signal
 *   3. unique person title ilike user name (weak)
 *
 * Agents are skipped. Never throws for missing data; empty roster is valid.
 */
export async function loadTeamRosterForCapture(
  db: Db,
  opts: { workspaceId: string; userId: string }
): Promise<TeamRosterContext> {
  const empty: TeamRosterContext = {
    names: [],
    instructionBlock: null,
    members: [],
  };

  if (!opts.workspaceId) return empty;

  const memberRows = await db
    .select({
      userId: workspaceMembers.userId,
      email: users.email,
      name: users.name,
      userType: users.userType,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, opts.workspaceId))
    .limit(MAX_TEAM_ROSTER);

  const humans = memberRows.filter((m) => m.userType !== "agent");
  if (humans.length === 0) return empty;

  // Batch strong-signal lookups (external_id + email).
  const signalClauses = humans.flatMap((m) => {
    const clauses = [
      and(
        eq(entityIdentitySignals.signalType, "external_id"),
        eq(entityIdentitySignals.signalValue, userExternalIdSignal(m.userId))
      ),
    ];
    if (m.email?.trim()) {
      clauses.push(
        and(
          eq(entityIdentitySignals.signalType, "email"),
          eq(
            entityIdentitySignals.signalValue,
            normalizeIdentitySignal("email", m.email.trim())
          )
        )
      );
    }
    return clauses;
  });

  type SignalHit = {
    entityId: string;
    signalType: string;
    signalValue: string;
  };
  let signalHits: SignalHit[] = [];
  if (signalClauses.length > 0) {
    signalHits = await db
      .select({
        entityId: entityIdentitySignals.entityId,
        signalType: entityIdentitySignals.signalType,
        signalValue: entityIdentitySignals.signalValue,
      })
      .from(entityIdentitySignals)
      .where(or(...signalClauses));
  }

  const byExternalId = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const hit of signalHits) {
    if (hit.signalType === "external_id") {
      byExternalId.set(hit.signalValue, hit.entityId);
    } else if (hit.signalType === "email") {
      byEmail.set(hit.signalValue, hit.entityId);
    }
  }

  // Resolve personId per member (strong first).
  const personIdByUserId = new Map<string, string>();
  const unmatchedWithName: Array<{ userId: string; name: string }> = [];

  for (const m of humans) {
    const ext = byExternalId.get(userExternalIdSignal(m.userId));
    if (ext) {
      personIdByUserId.set(m.userId, ext);
      continue;
    }
    if (m.email?.trim()) {
      const emailKey = normalizeIdentitySignal("email", m.email.trim());
      const viaEmail = byEmail.get(emailKey);
      if (viaEmail) {
        personIdByUserId.set(m.userId, viaEmail);
        continue;
      }
    }
    const name = m.name?.trim();
    if (name) unmatchedWithName.push({ userId: m.userId, name });
  }

  // Weak fallback: title ilike name, only when the match is unique among persons.
  for (const { userId, name } of unmatchedWithName) {
    const escaped = name.replace(/([%_\\])/g, "\\$1");
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          isNull(entities.deletedAt),
          eq(entities.type, "person"),
          ilike(entities.title, escaped)
        )
      )
      .limit(2);
    if (rows.length === 1 && rows[0]) {
      personIdByUserId.set(userId, rows[0].id);
    }
  }

  // Load matched person rows for titles / handles / aliases.
  const personIds = Array.from(new Set(personIdByUserId.values()));
  const personById = new Map<
    string,
    { id: string; title: string | null; properties: unknown }
  >();
  if (personIds.length > 0) {
    const personRows = await db
      .select({
        id: entities.id,
        title: entities.title,
        properties: entities.properties,
      })
      .from(entities)
      .where(and(inArray(entities.id, personIds), isNull(entities.deletedAt)));
    for (const p of personRows) {
      personById.set(p.id, p);
    }
  }

  const names = new Set<string>();
  const lines: TeamRosterMemberLine[] = [];

  for (const m of humans) {
    const displayName = m.name?.trim() || m.email?.trim() || "Member";
    const personId = personIdByUserId.get(m.userId) ?? null;
    const person = personId ? personById.get(personId) : undefined;
    const props = propertiesRecord(person?.properties);

    pushUnique(names, displayName);
    pushUnique(names, m.email);
    pushUnique(names, person?.title);
    pushUnique(names, props["discord-handle"]);
    pushUnique(names, props.discordHandle);
    for (const alias of asStringArray(props.aliases)) {
      pushUnique(names, alias);
    }

    lines.push({
      displayName,
      email: m.email?.trim() || null,
      // Only surface live person rows (deleted signal targets fall out of personById).
      personId: person?.id ?? null,
    });
  }

  const instructionBlock = formatTeamRosterBlock(lines);

  logger.debug(
    {
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      memberCount: humans.length,
      matchedPersons: personIdByUserId.size,
    },
    "team roster loaded for capture structure"
  );

  return {
    names: Array.from(names),
    instructionBlock,
    members: lines,
  };
}
