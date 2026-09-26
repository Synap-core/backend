/**
 * Definition seeds — the ONE door that lands a template's seed entities and
 * seeded relations on an EXISTING workspace.
 * ==========================================================================
 *
 * Adopt, never duplicate. A seed is identified by `(kind, title)` — the key the
 * fresh-create path (`createWorkspaceFromDefinition`) and the `applyDefinition`
 * update path already used. If a row with that key already exists for the user,
 * it is ADOPTED (its id is reused for the relations below, nothing is written);
 * only a missing seed is created.
 *
 * Callers (all go through here — never a second seed loop):
 *   - `composeOntoBaseWorkspace` — every overlay install (Hub
 *     `/packages/apply`, `market.install`, browser `createFromDefinition`,
 *     devplane `applyDefinition` create-mode, the resolver's transitive compose).
 *     Before W4b those doors applied an overlay's schema only; its seeds never
 *     landed, so installing `business-model` onto Foundation never adopted the
 *     nine live GRP questions.
 *   - `applyDefinition` update mode.
 *
 * Where it looks for an existing row: the TARGET workspace AND the user's
 * pod-wide rows (`workspace_id IS NULL`). A pod-scope kind (`question`) is
 * moved pod-wide by `reconcileEntityScope`; a workspace-only lookup would then
 * miss it and seed a duplicate on the next install.
 *
 * A seed the user DELETED (soft) stays deleted: it is counted as adopted, not
 * re-created, and relations that name it are skipped.
 *
 * Relation refs: templates write `sourceRef` as the seed's bare TITLE (the WT
 * `seed-obligation` test enforces that); older callers key by
 * `refKey` or `${profileSlug}:${title}`. All three resolve here.
 *
 * NOT handled here (unchanged, per path): profile auto-create (applyDefinition
 * update mode does it before calling), long seed `content` bodies (only the
 * fresh-create door materialises those).
 */

import {
  and,
  eq,
  inArray,
  isNull,
  or,
  entities,
  relations,
  EntityRepository,
  RelationRepository,
  ProfileRepository,
  ONBOARDING_SCAFFOLD_SYSTEM_DATA,
} from "@synap/database";
import { inheritRelationWorkspaceId } from "../lib/relation-workspace-inherit.js";

export interface DefinitionSeedEntity {
  profileSlug: string;
  title: string;
  properties?: Record<string, unknown>;
  refKey?: string;
}

export interface DefinitionSeedRelation {
  sourceRef: string;
  targetRef: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface DefinitionSeedError {
  stage: "entities" | "relations";
  refKey?: string;
  error: string;
}

export interface DefinitionSeedResult {
  /** refKey (`refKey ?? profileSlug:title`) → live entity id (created or adopted). */
  entityIds: Record<string, string>;
  entitiesCreated: number;
  /** Existing rows reused (incl. user-deleted seeds, which stay deleted). */
  entitiesAdopted: number;
  relationsCreated: number;
  relationsSkipped: number;
  errors: DefinitionSeedError[];
}

/** The seed list a definition carries — both field names are in use. */
export function definitionSeedEntities(definition: {
  suggestedEntities?: unknown;
  seedEntities?: unknown;
}): DefinitionSeedEntity[] {
  const list = (definition.suggestedEntities ?? definition.seedEntities) as
    DefinitionSeedEntity[] | undefined;
  return Array.isArray(list) ? list : [];
}

export function seedKey(e: { profileSlug: string; title: string }): string {
  return `${e.profileSlug}:${e.title}`;
}

type Db = ConstructorParameters<typeof EntityRepository>[0];
type EventRepo = ConstructorParameters<typeof EntityRepository>[1];

export async function applyDefinitionSeeds(opts: {
  database: Db;
  eventRepo: EventRepo;
  userId: string;
  workspaceId: string;
  seeds: DefinitionSeedEntity[];
  relations?: DefinitionSeedRelation[];
  /** slug → profile id; loaded from the workspace's accessible profiles when absent. */
  profileIds?: Map<string, string>;
}): Promise<DefinitionSeedResult> {
  const { database, eventRepo, userId, workspaceId, seeds } = opts;
  const result: DefinitionSeedResult = {
    entityIds: {},
    entitiesCreated: 0,
    entitiesAdopted: 0,
    relationsCreated: 0,
    relationsSkipped: 0,
    errors: [],
  };
  if (seeds.length === 0) return result;

  let profileIds = opts.profileIds;
  if (!profileIds) {
    const accessible = await new ProfileRepository(
      database as never
    ).getAccessibleProfiles(userId, workspaceId);
    profileIds = new Map(accessible.map((p) => [p.slug, p.id]));
  }

  // Existing rows with a seed's (kind, title): this workspace or pod-wide.
  const existing = await database.query.entities.findMany({
    where: and(
      eq(entities.userId, userId),
      or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId)),
      inArray(
        entities.type,
        Array.from(new Set(seeds.map((s) => s.profileSlug)))
      ),
      inArray(entities.title, Array.from(new Set(seeds.map((s) => s.title))))
    ),
    columns: {
      id: true,
      type: true,
      title: true,
      workspaceId: true,
      deletedAt: true,
    },
  });
  // Prefer a live row over a deleted one, then this workspace over pod-wide.
  const rank = (r: (typeof existing)[number]) =>
    (r.deletedAt ? 2 : 0) + (r.workspaceId === workspaceId ? 0 : 1);
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const r of existing) {
    const k = `${r.type}:${r.title}`;
    const prev = byKey.get(k);
    if (!prev || rank(r) < rank(prev)) byKey.set(k, r);
  }

  // Ref resolution: refKey, kind:title, and a title unique among the seeds.
  const refToId = new Map<string, string>();
  const titleCount = new Map<string, number>();
  for (const s of seeds)
    titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
  const endpointWs = new Map<string, string | null>();
  /** Refs naming a seed the user deleted — their edges are skipped, not errors. */
  const deletedRefs = new Set<string>();

  const entityRepo = new EntityRepository(database, eventRepo);
  for (const s of seeds) {
    const key = seedKey(s);
    const refKey = s.refKey ?? key;
    const found = byKey.get(key);
    let id: string | undefined;
    if (found) {
      result.entitiesAdopted++;
      if (found.deletedAt) {
        // Deleted by the user: stays deleted, and so do its seeded edges.
        deletedRefs.add(refKey).add(key).add(s.title);
        continue;
      }
      id = found.id;
      endpointWs.set(id, found.workspaceId);
    } else {
      const profileId = profileIds.get(s.profileSlug);
      if (!profileId) {
        result.errors.push({
          stage: "entities",
          refKey,
          error: `Profile ${s.profileSlug} not found on workspace`,
        });
        continue;
      }
      try {
        const created = await entityRepo.create(
          {
            profileId,
            title: s.title,
            properties: s.properties,
            systemData: ONBOARDING_SCAFFOLD_SYSTEM_DATA,
            workspaceId,
            userId,
            createdByKind: "system",
            skipValidation: true,
          },
          userId
        );
        id = created.id;
        endpointWs.set(id, workspaceId);
        byKey.set(key, {
          id,
          type: s.profileSlug,
          title: s.title,
          workspaceId,
          deletedAt: null,
        });
        result.entitiesCreated++;
      } catch (err) {
        result.errors.push({
          stage: "entities",
          refKey,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    result.entityIds[refKey] = id;
    refToId.set(refKey, id);
    refToId.set(key, id);
    if (titleCount.get(s.title) === 1) refToId.set(s.title, id);
  }

  const rels = opts.relations ?? [];
  if (rels.length === 0) return result;

  const ids = Array.from(new Set(refToId.values()));
  const existingRels = ids.length
    ? await database.query.relations.findMany({
        where: inArray(relations.sourceEntityId, ids),
        columns: { sourceEntityId: true, targetEntityId: true, type: true },
      })
    : [];
  const relKeys = new Set(
    existingRels.map((r) => `${r.sourceEntityId}:${r.targetEntityId}:${r.type}`)
  );
  const relationRepo = new RelationRepository(database, eventRepo);
  for (const rel of rels) {
    const sourceId = refToId.get(rel.sourceRef);
    const targetId = refToId.get(rel.targetRef);
    const ref = `${rel.sourceRef}->${rel.targetRef}`;
    if (!sourceId || !targetId) {
      if (deletedRefs.has(rel.sourceRef) || deletedRefs.has(rel.targetRef)) {
        result.relationsSkipped++;
      } else {
        result.errors.push({
          stage: "relations",
          refKey: ref,
          error: `Source or target seed not found: ${rel.sourceRef}=${sourceId}, ${rel.targetRef}=${targetId}`,
        });
      }
      continue;
    }
    const k = `${sourceId}:${targetId}:${rel.type}`;
    if (relKeys.has(k)) {
      result.relationsSkipped++;
      continue;
    }
    try {
      await relationRepo.create(
        {
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          type: rel.type,
          workspaceId: inheritRelationWorkspaceId(
            [
              endpointWs.get(sourceId) ?? null,
              endpointWs.get(targetId) ?? null,
            ],
            workspaceId
          ),
          userId,
          metadata: rel.metadata,
        },
        userId
      );
      relKeys.add(k);
      result.relationsCreated++;
    } catch (err) {
      result.errors.push({
        stage: "relations",
        refKey: ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
