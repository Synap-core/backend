/**
 * DECLARED RULES (plan 7d71ddcc W3): the reactions a relation between two
 * kinds declares (`profile_relations.metadata.reactions`, the closed union
 * read by `readRelationReactions`, `@synap-core/types/relations`), turned
 * into the reactor's declarations so they join THE one list beside the
 * built-in rules (`registerReactionSource`, `@synap/jobs` reactions): same
 * order, same guards, same log. Nothing else holds a rule (no reactions
 * table), and nothing here runs one: the reactor applies it, the compile
 * pass (`reaction-rules-compile.ts`) gives each one its visible, pausable
 * rule row.
 *
 * Roll-up only (decision D7). A pair whose kind at the child end is a ROLE is
 * reported, not compiled: a role's status lives on its facet, and the parts
 * reader reads a kind's own lifecycle columns.
 */
import {
  db,
  inArray,
  drizzleSql,
  profileRelations,
  profiles,
  relationDefs,
  eq,
} from "@synap/database";
import { readRelationReactions } from "@synap-core/types/relations";
import type {
  ReactionDeclaration,
  ReactionSource,
} from "@synap/jobs/utils/reactions.js";

/** Declared rules run after the built-in ones (10, 20, …), ties by id. */
export const DECLARED_REACTION_ORDER = 100;

/** The stable id of a pair's roll-up: the dedupe key and the log's subject. */
export function relationRollupId(pair: {
  relationDefId: string;
  sourceProfileId: string;
  targetProfileId: string;
}): string {
  return `declared:rollup:${pair.relationDefId}:${pair.sourceProfileId}:${pair.targetProfileId}`;
}

export interface RelationReactionsCompiled {
  declarations: ReactionDeclaration[];
  /** Pairs whose declaration could not be compiled, in words. */
  errors: Array<{ pair: string; reason: string }>;
}

type ProfileFacts = {
  id: string;
  slug: string;
  name: string;
  kind: string | null;
};

const lower = (s: string) => s.toLowerCase();

/** The rule's title in the person's words, when they gave none. Pure. */
export function rollupTitle(input: {
  child: string;
  parent: string;
  relationName: string;
  parentEnd: "target" | "source";
  to: string | null;
}): string {
  const moves = input.to
    ? `the ${lower(input.parent)} moves to ${input.to.replace(/_/g, " ")}`
    : `the ${lower(input.parent)} moves to its next status`;
  return input.parentEnd === "target"
    ? `When every ${lower(input.child)} ${lower(input.relationName)} a ${lower(input.parent)} is done, ${moves}`
    : `When every ${lower(input.child)} a ${lower(input.parent)} ${lower(input.relationName)} is done, ${moves}`;
}

/**
 * Every relation pair that declares reactions, compiled. ONE read of the
 * pairs (those whose metadata carries the key), one of their kinds.
 */
export async function readRelationReactionDeclarations(): Promise<RelationReactionsCompiled> {
  const pairs = await db
    .select({
      sourceProfileId: profileRelations.sourceProfileId,
      targetProfileId: profileRelations.targetProfileId,
      relationDefId: profileRelations.relationDefId,
      metadata: profileRelations.metadata,
      relation: relationDefs.slug,
      relationName: relationDefs.displayName,
      relationUserId: relationDefs.userId,
      workspaceId: relationDefs.workspaceId,
    })
    .from(profileRelations)
    .innerJoin(
      relationDefs,
      eq(relationDefs.id, profileRelations.relationDefId)
    )
    .where(drizzleSql`${profileRelations.metadata} ? 'reactions'`);
  const out: RelationReactionsCompiled = { declarations: [], errors: [] };
  if (pairs.length === 0) return out;
  const ids = [
    ...new Set(pairs.flatMap((p) => [p.sourceProfileId, p.targetProfileId])),
  ];
  const kinds = new Map<string, ProfileFacts>(
    (
      await db
        .select({
          id: profiles.id,
          slug: profiles.slug,
          name: profiles.displayName,
          kind: profiles.profileKind,
        })
        .from(profiles)
        .where(inArray(profiles.id, ids))
    ).map((p) => [p.id, p])
  );
  for (const p of pairs) {
    const source = kinds.get(p.sourceProfileId);
    const target = kinds.get(p.targetProfileId);
    const pairName = `${source?.slug ?? p.sourceProfileId} ${p.relation} ${target?.slug ?? p.targetProfileId}`;
    if (!source || !target) {
      out.errors.push({
        pair: pairName,
        reason: "A kind of the pair is gone.",
      });
      continue;
    }
    const read = readRelationReactions(p.metadata);
    for (const reason of read.errors)
      out.errors.push({ pair: pairName, reason });
    for (const decl of read.declarations) {
      const parentEnd = decl.parent ?? "target";
      const child = parentEnd === "target" ? source : target;
      const parent = parentEnd === "target" ? target : source;
      if (child.kind === "role") {
        out.errors.push({
          pair: pairName,
          reason: `"${child.slug}" is a role: a roll-up reads a kind's own status.`,
        });
        continue;
      }
      out.declarations.push({
        id: relationRollupId(p),
        title:
          decl.title ??
          rollupTitle({
            child: child.name,
            parent: parent.name,
            relationName: p.relationName,
            parentEnd,
            to: decl.to ?? null,
          }),
        when: {
          subjectType: "entity",
          // A part reaching done completes the set; one reaching lost can
          // too (a lost part is ignored, D5).
          category: ["done", "lost"],
          profileSlug: [child.slug],
        },
        via: {
          link: "relation",
          relation: p.relation,
          parent: parentEnd,
          relationDefId: p.relationDefId,
          sourceProfileId: p.sourceProfileId,
          targetProfileId: p.targetProfileId,
        },
        do: { effect: "roll_up", ...(decl.to ? { to: decl.to } : {}) },
        order: DECLARED_REACTION_ORDER,
        ...(decl.chains ? { chains: true } : {}),
        ...(decl.terminal ? { terminal: decl.terminal } : {}),
        ...(decl.terminalWhy ? { terminalWhy: decl.terminalWhy } : {}),
        source: "declared",
        enabled: true,
        declaredOn: {
          kind: "relation",
          relation: p.relation,
          relationName: p.relationName,
          source: {
            profileId: source.id,
            slug: source.slug,
            name: source.name,
          },
          target: {
            profileId: target.id,
            slug: target.slug,
            name: target.name,
          },
          workspaceId: p.workspaceId ?? null,
          userId: p.relationUserId ?? null,
        },
      });
    }
  }
  return out;
}

/** The source the reactor lists: declared roll-ups listen to thing moves. */
export const relationReactionSource: ReactionSource = {
  id: "relation-reactions",
  subjectTypes: ["entity"],
  async list() {
    return (await readRelationReactionDeclarations()).declarations;
  },
};
