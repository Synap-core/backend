/**
 * Property-index drift test — the projection is rebuilt from truth.
 *
 * INVARIANT (bricks / kind+facets): `entity_property_index` is a PROJECTION of
 * `entities`, never a source of truth. This proves it: index a fixture entity,
 * corrupt its index row directly, run the rebuild, and assert the projection is
 * restored byte-for-byte from the entity's `properties`.
 *
 * Requires a live Postgres AND the schema module graph loaded natively (see the
 * SCHEMA_LOADS note below, shared with reconcile-workspace-from-definition).
 * Skips cleanly otherwise — like every DB-gated suite here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { sql } from "../client-pg.js";
import {
  createWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "../utils/create-workspace-from-definition.js";
import { rebuildEntityProjections } from "../scripts/rebuild-property-index.js";
import { profileWorkspaceAccess } from "../schema/profiles.js";

// The schema module graph has a circular import (profiles ↔ workspaces) that
// vite's SSR transform (vitest) leaves with undefined table bindings; a native
// ESM harness resolves it. `profileWorkspaceAccess` being defined is the probe:
// truthy → run against Postgres; falsy → skip cleanly (also how this suite
// no-ops when Postgres is absent).
const SCHEMA_LOADS = !!profileWorkspaceAccess;

const suf = crypto.randomUUID().slice(0, 8);
const userId = `test-pidrift-${suf}`;
const itemSlug = `titem-${suf}`;

let workspaceId: string;
let profileId: string;
let entityId: string;

// A single hot property (`status` is on PropertyIndexService's hot list) so the
// rebuild actually indexes something.
const definition: WorkspaceDefinitionInput = {
  workspaceName: `PIDrift ${suf}`,
  profiles: [
    {
      slug: itemSlug,
      displayName: "Item",
      properties: [{ slug: "status", label: "Status", valueType: "text" }],
    },
  ],
};

/** Projection payload for an entity, id/timestamp-independent, ordered. */
async function projectionOf(eid: string) {
  return sql`
    SELECT property_def_id, value_text, value_num, value_bool,
           value_ts, value_entity_id, value_jsonb
    FROM entity_property_index
    WHERE entity_id = ${eid}
    ORDER BY property_def_id
  `;
}

describe.skipIf(!SCHEMA_LOADS)(
  "property-index drift — projection rebuilt from truth",
  () => {
    beforeAll(async () => {
      await sql`
        INSERT INTO users (id, email, name)
        VALUES (${userId}, ${`${userId}@test.local`}, 'PIDrift Test')
        ON CONFLICT (id) DO NOTHING
      `;
      const result = await createWorkspaceFromDefinition({
        definition,
        userId,
        createdBy: "user",
      });
      workspaceId = result.workspaceId;

      const [profile] = await sql`
        SELECT id FROM profiles WHERE workspace_id = ${workspaceId} AND slug = ${itemSlug}
      `;
      profileId = profile.id as string;

      const [entity] = await sql`
        INSERT INTO entities (user_id, type, profile_id, workspace_id, properties, title)
        VALUES (${userId}, ${itemSlug}, ${profileId}, ${workspaceId},
                ${sql.json({ status: "todo" })}, 'Drift fixture')
        RETURNING id
      `;
      entityId = entity.id as string;
    });

    afterAll(async () => {
      if (entityId) {
        await sql`DELETE FROM entity_property_index WHERE entity_id = ${entityId}`;
        await sql`DELETE FROM entities WHERE id = ${entityId}`;
      }
      if (workspaceId) {
        await sql`DELETE FROM profile_properties WHERE profile_id IN (SELECT id FROM profiles WHERE workspace_id = ${workspaceId})`;
        await sql`DELETE FROM property_defs WHERE profile_id IN (SELECT id FROM profiles WHERE workspace_id = ${workspaceId})`;
        await sql`DELETE FROM views WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM profiles WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      }
      await sql`DELETE FROM users WHERE id = ${userId}`;
    });

    it("restores a corrupted index row from the entity's properties", async () => {
      const rebuildable = {
        id: entityId,
        profileId,
        properties: { status: "todo" },
        workspaceId,
      };

      // 1. Index from truth → a row for the hot `status` prop must exist.
      await rebuildEntityProjections(rebuildable);
      const clean = await projectionOf(entityId);
      expect(clean.length).toBeGreaterThanOrEqual(1);

      // 2. Corrupt the projection directly (simulate drift).
      await sql`
        UPDATE entity_property_index
        SET value_text = 'DRIFT', value_num = NULL, value_bool = NULL,
            value_ts = NULL, value_entity_id = NULL, value_jsonb = ${sql.json("DRIFT")}
        WHERE entity_id = ${entityId}
      `;
      const corrupted = await projectionOf(entityId);
      expect(corrupted).not.toEqual(clean); // drift took hold

      // 3. Rebuild → projection restored byte-for-byte from the entity.
      await rebuildEntityProjections(rebuildable);
      const restored = await projectionOf(entityId);
      expect(restored).toEqual(clean);
    });
  }
);
